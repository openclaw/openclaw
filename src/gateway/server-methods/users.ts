// Gateway methods for durable user profile administration.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateUsersLinkEmailParams,
  validateUsersListParams,
  validateUsersSetAvatarParams,
  validateUsersSetDisplayNameParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  linkEmail,
  listProfiles,
  setAvatar,
  setDisplayName,
  UserProfileNotFoundError,
} from "../../state/user-profiles.js";
import type { GatewayRequestHandlers } from "./types.js";

function decodeBase64(value: string): Uint8Array | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(trimmed)
  ) {
    return undefined;
  }
  return Buffer.from(trimmed, "base64");
}

function invalidParams(name: string, errors: Parameters<typeof formatValidationErrors>[0]) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${name} params: ${formatValidationErrors(errors)}`,
  );
}

function profileError(error: unknown) {
  if (error instanceof UserProfileNotFoundError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, error.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
}

// Trusted-proxy identity is not yet exposed to RPC handlers on main; follow-up adds self-service.
export const usersHandlers: GatewayRequestHandlers = {
  "users.list": ({ params, respond }) => {
    if (!validateUsersListParams(params)) {
      respond(false, undefined, invalidParams("users.list", validateUsersListParams.errors));
      return;
    }
    respond(true, { profiles: listProfiles() });
  },
  "users.linkEmail": ({ params, respond }) => {
    if (!validateUsersLinkEmailParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("users.linkEmail", validateUsersLinkEmailParams.errors),
      );
      return;
    }
    try {
      respond(true, { profile: linkEmail(params.email, params.targetProfileId) });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setDisplayName": ({ params, respond }) => {
    if (!validateUsersSetDisplayNameParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("users.setDisplayName", validateUsersSetDisplayNameParams.errors),
      );
      return;
    }
    try {
      respond(true, { profile: setDisplayName(params.profileId, params.displayName) });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setAvatar": ({ params, respond }) => {
    if (!validateUsersSetAvatarParams(params)) {
      respond(
        false,
        undefined,
        invalidParams("users.setAvatar", validateUsersSetAvatarParams.errors),
      );
      return;
    }
    const bytes = decodeBase64(params.avatarBase64);
    if (!bytes) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "avatarBase64 must be base64"),
      );
      return;
    }
    try {
      const result = setAvatar(params.profileId, bytes, params.mime);
      if (!result.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error.code));
        return;
      }
      respond(true, { profile: result.value });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
};
