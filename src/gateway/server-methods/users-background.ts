import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
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
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

/** Bind private profile work to this live human connection before asynchronous image decoding. */
export async function prepareUserBackgroundAction(
  options: Omit<GatewayRequestHandlerOptions, "params">,
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

function backgroundHandler<P extends object>(
  operation: "get" | "upload" | "remove",
  validate: Validator<P>,
  run: (
    action: Awaited<ReturnType<typeof prepareUserBackgroundAction>>,
    options: Omit<GatewayRequestHandlerOptions, "params"> & { params: P },
  ) => Promise<Awaited<ReturnType<typeof getUserBackground>>>,
  mapError: (error: unknown) => ErrorShape,
): GatewayRequestHandlers[string] {
  return defineValidatedGatewayHandler(
    `users.background.${operation}`,
    validate,
    async (options) => {
      const { client, respond, context } = options;
      if (!client?.authenticatedUserProfile) {
        respond(true, { status: "no_durable_identity" });
        return;
      }
      const action = await prepareUserBackgroundAction(
        options,
        operation === "get" ? "operator.read" : "operator.write",
      );
      const result = await run(action, options);
      action.assertCurrent();
      respond(true, result);
      if (operation !== "get" && result.status === "ok") {
        publishUserPreferencesChanged(context, action.owner, [USER_BACKGROUND_PREFERENCE_KEY]);
      }
    },
    mapError,
  );
}

export const usersBackgroundHandlers: GatewayRequestHandlers = {
  "users.background.get": backgroundHandler(
    "get",
    validateUsersBackgroundGetParams,
    (action) => getUserBackground(action.owner, action),
    () => errorShape(ErrorCodes.FORBIDDEN, "Backgrounds require a current authenticated profile"),
  ),
  "users.background.upload": backgroundHandler(
    "upload",
    validateUsersBackgroundUploadParams,
    (action, { params, signal }) =>
      uploadUserBackground(action.owner, params, { ...action, signal }),
    (error) =>
      errorShape(
        error instanceof UserBackgroundInputError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "Background upload failed",
      ),
  ),
  "users.background.remove": backgroundHandler(
    "remove",
    validateUsersBackgroundRemoveParams,
    (action, { params }) => removeUserBackground(action.owner, params, action),
    () =>
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "Background removal failed; reload your preference and retry",
      ),
  ),
};
