/*jshint esversion: 6 */

function (user, context, callback) {
  // modules/group-intersection.js
  const groupIntersection = (groups, filter) => {
    const overlap = new Set();

    const filters = filter.map(i => {
      return new RegExp(i.replace(/\./g, '\.').replace(/\?/g, '.').replace(/\*/g, '.*'));
    });

    groups.forEach(group => {
      for (let filter of filters) {
        if (filter.test(group)) {
          overlap.add(group);
          break;
        }
      }
    });

    return [...overlap];
  };

  const WHITELIST = [
    '7PQFR1tyqr6TIqdHcgbRcYcbmbgYflVE', // ldap-pwless.testrp.security.allizom.org
    'xRFzU2bj7Lrbo3875aXwyxIArdkq1AOT', // Federated AWS CLI auth0-dev
    'N7lULzWtfVUDGymwDs0yDEq6ZcwmFazj', // Federated AWS CLI auth0-prod
  ];
  if (WHITELIST.indexOf(context.clientID) >= 0) {
    const S3_BUCKET_NAME = configuration.auth0_aws_assests_s3_bucket;
    const S3_FILE_NAME = "access-group-iam-role-map.json";
    const ACCESS_KEY_ID = configuration.auth0_aws_assests_access_key_id;
    const SECRET_KEY = configuration.auth0_aws_assests_access_secret_key;

    if (!("group_role_map_s3_bucket" in configuration) ||
        !("group_role_map_aws_access_key_id" in configuration) ||
        !("group_role_map_aws_secret_key" in configuration)) {
      console.log("Enriching id_token with amr for AWS Federated CLI");
      throw new Error("missing configuration values");
    }
    console.log("Enriching id_token with amr for AWS Federated CLI");
    // Amazon will read in the id token's `amr` list and allow you to match on policies with a string condition.
    // See
    // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html#Conditions_String
    //
    // Note that this abuses the `amr` value (see https://tools.ietf.org/html/rfc8176) as these are not listed as
    // registered values, and that groups are not authentication methods.
    //
    // NOTES:
    // - Amazon will accept an id_token of MAXIMUM 2048 bytes
    // - Amazon will process an `amr` value in that token that results in a certain unknown maximum size. Through
    // experimenting with sizes, this is about 26 groups of "reasonable size" (15-20 characters). This means we
    // shouldn't send too many groups in the `amr` or things will fail.

    // Fetching valid groups as we need to reduce `amr`
    // NOTE: This rule REQUIRES configuration.aws_mapping_url to be set. The file looks like this:
    // {
    //  "team_opsec": [
    //    "arn:aws:iam::656532927350:role/gene-test-federated-role-mozlando"
    //  ],
    //  "vpn_eis_automation" : [
    //      "arn:aws:iam::656532927350:role/federated-aws-cli-test-may2019"
    //    ]
    // }
    const updateAmr = function(user, context, callback) {
      let aws_groups = Object.keys(global.awsGroupRoleMap);
      user.groups = user.groups || [];
      context.idToken.amr = groupIntersection(user.groups, aws_groups);
      console.log(`User groups: ${user.groups.join(", ")}`);
      console.log(`AWS groups: ${aws_groups.join(", ")}`);
      console.log("Intersection of user groups and AWS groups: " + context.idToken.amr);

      // If Auth0 is going to send the user to Duo, Auth0 will modify the `amr` claim. Auth0 will specifically
      // overwrite the first element in the `amr` list (slot 0) with the string `mfa`. Anything put in slot 0
      // of the list by this rule may be overwritten by this `mfa` value. In cases where the user already has a
      // valid session with Duo, Auth0 will not overwrite slot 0 of the `amr` claim. As a result, this rule adds
      // a single element at the beginning of the `amr` claim list, an empty string. This slot 0 empty string
      // will be overwritten by the string `mfa` when users log into Duo and will be left in place when users have
      // a valid Duo session already. In the future it's possible that Auth0 will either add a different valid
      // `amr` value (other than `mfa`) or possibly additional `amr` values which could overwrite additional
      // elements in the `amr` claim list. This rule does not account for these possible future issues.
      context.idToken.amr.splice(0, 0, "");

      console.log("Returning idToken with idToken.amr size == "+context.idToken.amr.length+" (should be ~< 26 and idToken < 2048) for user_id "+user.user_id);
      return callback(null, user, context);
    };
    // Try to take advantage of a cached copy of the awsGroupRoleMap from a previous webtask run
    // If there is no cached copy, fetch a new one.
    if (!global.awsGroupRoleMap) {
      let AWS = require('aws-sdk');
      let s3 = new AWS.S3({
        apiVersion: '2006-03-01',
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_KEY,
        region: 'us-west-2',
        logger: console
      });
      s3.getObject({Bucket: S3_BUCKET_NAME, Key: S3_FILE_NAME},
        function(error, data) {
          if (error) {
            console.error(
                'Could not fetch AWS group role map from S3: ' + error + ' : ' + error.stack);
            global.awsGroupRoleMap = {};
          } else {
            console.log('Fetched ' + S3_BUCKET_NAME + '/' + S3_FILE_NAME + ' from S3');
            global.awsGroupRoleMap = JSON.parse(data.Body.toString());
          }
          return updateAmr(user, context, callback);
        }
      );
    } else {
      return updateAmr(user, context, callback);
    }
  } else {
    return callback(null, user, context);
  }
}
