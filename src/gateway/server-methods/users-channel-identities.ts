import {
  ErrorCodes,
  errorShape,
  type UsersLinkChannelIdentityParams,
  validateUsersLinkChannelIdentityParams,
  validateUsersListChannelIdentitiesParams,
  validateUsersUnlinkChannelIdentityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { UserChannelIdentityConflictError } from "../../state/user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
} from "../../state/user-channel-identity-operations.js";
import {
  UserProfileNotFoundError,
  UserProfileOwnerError,
} from "../../state/user-profiles-schema.js";
import type { GatewayRequestHandlers } from "./types.js";
import { prepareUserProfileAdministration } from "./users-profile-access.js";
import { defineValidatedGatewayMethod, type Validator } from "./validation.js";

function identityError(error: unknown) {
  return errorShape(
    error instanceof UserChannelIdentityConflictError ||
      error instanceof UserProfileNotFoundError ||
      error instanceof UserProfileOwnerError
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

function identityMutationHandler(
  method: "users.linkChannelIdentity" | "users.unlinkChannelIdentity",
  validate: Validator<UsersLinkChannelIdentityParams>,
  action: "link" | "unlink",
) {
  return defineValidatedGatewayMethod(
    method,
    validate,
    async (options) => {
      const { params, respond } = options;
      const assertCurrent = await prepareUserProfileAdministration(options);
      const result = await changeCanonicalUserChannelIdentity(
        action,
        params.profileId,
        params.identity,
        { assertCurrent },
      );
      if (result.kind !== (action === "link" ? "linked" : "unlinked")) {
        throw new Error("Channel identity mutation returned an unexpected result");
      }
      respond(true, result.kind === "linked" ? result.link : { removed: result.removed });
    },
    identityError,
  );
}

export const usersChannelIdentityHandlers: GatewayRequestHandlers = {
  "users.linkChannelIdentity": identityMutationHandler(
    "users.linkChannelIdentity",
    validateUsersLinkChannelIdentityParams,
    "link",
  ),
  "users.unlinkChannelIdentity": identityMutationHandler(
    "users.unlinkChannelIdentity",
    validateUsersUnlinkChannelIdentityParams,
    "unlink",
  ),
  "users.listChannelIdentities": defineValidatedGatewayMethod(
    "users.listChannelIdentities",
    validateUsersListChannelIdentitiesParams,
    async (options) => {
      const { params, respond } = options;
      const assertCurrent = await prepareUserProfileAdministration(options);
      const links = await listCanonicalUserChannelIdentities(params.profileId);
      assertCurrent();
      respond(true, { links });
    },
    identityError,
  ),
};
