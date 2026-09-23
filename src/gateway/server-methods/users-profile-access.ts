// Shared self-or-admin mutation policy for durable user profile methods.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { ensureProfileForEmail, resolveUserProfileId } from "../../state/user-profiles.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function resolveAuthenticatedProfileId(
  client: GatewayRequestHandlerOptions["client"],
): string | undefined {
  if (client?.authenticatedUserProfile?.profileId) {
    return resolveUserProfileId(client.authenticatedUserProfile.profileId);
  }
  if (client?.authenticatedGitHubIdentitySync) {
    return undefined;
  }
  const authenticatedUserId = client?.authenticatedUserId;
  if (!authenticatedUserId) {
    return undefined;
  }
  // A failed Tailscale profile snapshot must not recreate its provider login
  // through the legacy email resolver on a later self-profile request.
  if (client.authenticatedUserIsTailscaleProvider) {
    return undefined;
  }
  return ensureProfileForEmail(authenticatedUserId).id;
}

function canMutateProfile(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
): boolean {
  if (client?.connect.scopes?.includes(ADMIN_SCOPE)) {
    return true;
  }
  const authenticatedProfileId = resolveAuthenticatedProfileId(client);
  return (
    authenticatedProfileId !== undefined &&
    authenticatedProfileId === resolveUserProfileId(profileId)
  );
}

export function requireProfileMutationAccess(
  client: GatewayRequestHandlerOptions["client"],
  profileId: string,
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  // These methods are write-scoped so an identified caller can edit only its own profile;
  // edits targeting any other profile remain admin-only.
  if (canMutateProfile(client, profileId)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, "profile edits require the owning user or operator.admin"),
  );
  return false;
}

export async function prepareUserProfileAdministration(options: GatewayRequestHandlerOptions) {
  const { client, context } = options;
  const lifetime = readGatewayRequestMutationAuthority(options);
  const assertLifetime = lifetime.assertLifetimeCurrent;
  assertLifetime();
  const actor = resolveGatewayOperatorRoleActor(client);
  const authenticatedProfileId = client?.authenticatedUserProfile?.profileId;
  const sharedOwner = actor === undefined && authenticatedProfileId === GATEWAY_OWNER_PROFILE_ID;
  const role =
    actor?.kind === "operator" && actor.profileId
      ? await prepareUserProfileRoleAuthority(actor.profileId)
      : undefined;
  const assertCurrent = () => {
    assertLifetime();
    if (options.client !== client || options.context !== context) {
      throw new Error("Gateway requester authority changed");
    }
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      client?.authenticatedUserProfile?.profileId !== authenticatedProfileId ||
      currentActor?.kind !== actor?.kind ||
      (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !==
        (actor?.kind === "operator" ? actor.profileId : undefined)
    ) {
      throw new Error("Gateway requester profile changed");
    }
    if (
      client?.connect &&
      ((client.connect.role ?? "operator") !== "operator" ||
        !client.connect.scopes?.includes("operator.admin"))
    ) {
      throw new Error("Profile administration requires operator.admin");
    }
    if (actor?.kind === "operator" && (!role || !role.isCurrent())) {
      throw new Error("Gateway administrator profile authority changed");
    }
    lifetime.expectedProfileBinding?.assertCurrent();
    const cfg = context.getRuntimeConfig();
    const policy =
      actor?.kind === "system"
        ? undefined
        : resolveOperatorRolePolicyForAssignment(
            sharedOwner ? authenticatedProfileId : role?.profileId,
            role?.role ?? null,
            cfg,
          );
    if (policy && !policy.scopes.includes("operator.admin")) {
      throw new Error("Profile administration requires operator.admin");
    }
  };
  assertCurrent();
  return assertCurrent;
}
