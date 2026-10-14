import {
  ErrorCodes,
  errorShape,
  validateUsersBackgroundGetParams,
  validateUsersBackgroundUploadParams,
  validateUsersBackgroundRemoveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { USER_BACKGROUND_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/background-preferences.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { UserBackgroundInputError } from "../../state/user-background-image.js";
import {
  getUserBackground,
  removeUserBackground,
  uploadUserBackground,
} from "../../state/user-background.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { resolveOperatorRolePolicyForAssignment } from "../operator-role-policy.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import { isIneligiblePersonalGatewayCaller } from "./gateway-personal-caller.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";
import { assertValidParams } from "./validation.js";

/** Bind private profile work to this live human connection before asynchronous image decoding. */
export async function prepareUserBackgroundAction(
  options: GatewayRequestHandlerOptions,
  scope: "operator.read" | "operator.write",
) {
  const { client, context } = options;
  const lifetime = readGatewayRequestMutationAuthority(options);
  const reference = client?.authenticatedUserProfile?.profileId;
  if (!reference) {
    throw new Error("Backgrounds require an authenticated profile");
  }
  lifetime.assertLifetimeCurrent();
  const profile = await prepareUserProfileRoleAuthority(reference);
  const owner = profile?.profileId;
  if (!owner || !profile) {
    throw new Error("Backgrounds require an authenticated profile");
  }
  const assertCurrent = () => {
    lifetime.assertLifetimeCurrent();
    lifetime.expectedProfileBinding?.assertCurrent();
    if (
      !owner ||
      !client?.connId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      options.signal?.aborted ||
      client.connect.role !== "operator" ||
      isIneligiblePersonalGatewayCaller(client) ||
      isGatewayClientProfilePending(client) ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId) ||
      !profile.isCurrent() ||
      client.authenticatedUserProfile?.profileId !== reference
    ) {
      throw new Error("Background request no longer belongs to a connected profile");
    }
    const policy = resolveOperatorRolePolicyForAssignment(
      owner,
      profile.role,
      context.getRuntimeConfig(),
      profile.githubLogin ?? null,
    );
    if (
      ![client.connect.scopes ?? [], ...(policy ? [policy.scopes] : [])].every((allowedScopes) =>
        roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
      )
    ) {
      throw new Error("Background request no longer has the required profile scope");
    }
  };
  assertCurrent();
  return { owner, assertCurrent };
}

export const usersBackgroundHandlers: GatewayRequestHandlers = {
  "users.background.get": async (options) => {
    const { client, params, respond } = options;
    if (
      !assertValidParams(params, validateUsersBackgroundGetParams, "users.background.get", respond)
    ) {
      return;
    }
    if (!client?.authenticatedUserProfile) {
      respond(true, { status: "no_durable_identity" });
      return;
    }
    try {
      const action = await prepareUserBackgroundAction(options, "operator.read");
      const result = await getUserBackground(action.owner, action);
      action.assertCurrent();
      respond(true, result);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Backgrounds require a current authenticated profile"),
      );
    }
  },
  "users.background.upload": async (options) => {
    const { client, params, respond, context, signal } = options;
    if (
      !assertValidParams(
        params,
        validateUsersBackgroundUploadParams,
        "users.background.upload",
        respond,
      )
    ) {
      return;
    }
    if (!client?.authenticatedUserProfile) {
      respond(true, { status: "no_durable_identity" });
      return;
    }
    try {
      const action = await prepareUserBackgroundAction(options, "operator.write");
      const result = await uploadUserBackground(action.owner, params, { ...action, signal });
      action.assertCurrent();
      respond(true, result);
      if (result.status === "ok") {
        publishUserPreferencesChanged(context, action.owner, [USER_BACKGROUND_PREFERENCE_KEY]);
      }
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          error instanceof UserBackgroundInputError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "Background upload failed",
        ),
      );
    }
  },
  "users.background.remove": async (options) => {
    const { client, params, respond, context } = options;
    if (
      !assertValidParams(
        params,
        validateUsersBackgroundRemoveParams,
        "users.background.remove",
        respond,
      )
    ) {
      return;
    }
    if (!client?.authenticatedUserProfile) {
      respond(true, { status: "no_durable_identity" });
      return;
    }
    try {
      const action = await prepareUserBackgroundAction(options, "operator.write");
      const result = await removeUserBackground(action.owner, params, action);
      action.assertCurrent();
      respond(true, result);
      if (result.status === "ok") {
        publishUserPreferencesChanged(context, action.owner, [USER_BACKGROUND_PREFERENCE_KEY]);
      }
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Background removal failed; reload your preference and retry",
        ),
      );
    }
  },
};
