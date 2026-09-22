import {
  ErrorCodes,
  errorShape,
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
import { assertValidParams } from "./validation.js";

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

export const usersChannelIdentityHandlers: GatewayRequestHandlers = {
  "users.linkChannelIdentity": async (options) => {
    const { params, respond } = options;
    if (
      !assertValidParams(
        params,
        validateUsersLinkChannelIdentityParams,
        "users.linkChannelIdentity",
        respond,
      )
    ) {
      return;
    }
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      const result = await changeCanonicalUserChannelIdentity(
        "link",
        params.profileId,
        params.identity,
        { assertCurrent },
      );
      if (result.kind !== "linked") {
        throw new Error("Channel identity mutation returned an unexpected result");
      }
      respond(true, result.link);
    } catch (error) {
      respond(false, undefined, identityError(error));
    }
  },
  "users.unlinkChannelIdentity": async (options) => {
    const { params, respond } = options;
    if (
      !assertValidParams(
        params,
        validateUsersUnlinkChannelIdentityParams,
        "users.unlinkChannelIdentity",
        respond,
      )
    ) {
      return;
    }
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      const result = await changeCanonicalUserChannelIdentity(
        "unlink",
        params.profileId,
        params.identity,
        { assertCurrent },
      );
      if (result.kind !== "unlinked") {
        throw new Error("Channel identity mutation returned an unexpected result");
      }
      respond(true, { removed: result.removed });
    } catch (error) {
      respond(false, undefined, identityError(error));
    }
  },
  "users.listChannelIdentities": async (options) => {
    const { params, respond } = options;
    if (
      !assertValidParams(
        params,
        validateUsersListChannelIdentitiesParams,
        "users.listChannelIdentities",
        respond,
      )
    ) {
      return;
    }
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      const links = await listCanonicalUserChannelIdentities(params.profileId);
      assertCurrent();
      respond(true, { links });
    } catch (error) {
      respond(false, undefined, identityError(error));
    }
  },
};
