import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { ensureProfileIdForEmail } from "../../state/user-profile-email.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function prepareAuthenticatedProfile(options: GatewayRequestHandlerOptions) {
  const { client } = options;
  const lifetime = readGatewayRequestMutationAuthority(options);
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const email = client?.authenticatedUserId;
  const sync = client?.authenticatedGitHubIdentitySync;
  const provider = client?.authenticatedUserIsTailscaleProvider;
  const connectionId = client?.connId;
  const role = client?.connect.role;
  const scopes = [...(client?.connect.scopes ?? [])];
  const assertConnection = () => {
    lifetime.assertLifetimeCurrent();
    lifetime.expectedProfileBinding?.assertCurrent();
    if (
      options.client !== client ||
      client?.connId !== connectionId ||
      client?.connect.role !== role ||
      scopes.some((scope) => !client?.connect.scopes?.includes(scope)) ||
      client?.connectionSignal?.aborted ||
      client?.authenticatedUserProfile?.profileId !== profileReference ||
      client?.authenticatedUserId !== email ||
      client?.authenticatedGitHubIdentitySync !== sync ||
      client?.authenticatedUserIsTailscaleProvider !== provider
    ) {
      throw new Error("Gateway requester profile changed");
    }
  };
  assertConnection();
  // Failed provider acquisition must never create an email alias for its login.
  const legacyEmail = !profileReference && !sync && !provider ? email : undefined;
  const reference =
    profileReference ??
    (legacyEmail ? await ensureProfileIdForEmail(legacyEmail, {}, assertConnection) : undefined);
  assertConnection();
  const profile = reference ? await prepareUserProfileRoleAuthority(reference) : undefined;
  assertConnection();
  // Bind the alias after authority capture to reject relinking between the two reads.
  if (
    legacyEmail &&
    (await ensureProfileIdForEmail(legacyEmail, {}, assertConnection)) !== profile?.profileId
  ) {
    throw new Error("Gateway requester profile changed");
  }
  const assertCurrent = () => {
    assertConnection();
    if (profile && !profile.isCurrent()) {
      throw new Error("Gateway requester profile changed");
    }
  };
  assertCurrent();
  return { profileId: profile?.profileId, assertCurrent };
}

export async function prepareProfileMutationAccess(
  options: GatewayRequestHandlerOptions,
  profileId: string,
) {
  const requester = await prepareAuthenticatedProfile(options);
  requester.assertCurrent();
  const target = options.client?.connect.scopes?.includes(ADMIN_SCOPE)
    ? undefined
    : await prepareUserProfileRoleAuthority(profileId);
  const assertCurrent = () => {
    requester.assertCurrent();
    if (
      options.client?.connect.scopes?.includes(ADMIN_SCOPE) ||
      (target?.isCurrent() && requester.profileId === target.profileId)
    ) {
      return;
    }
    throw new Error("profile edits require the owning user or operator.admin");
  };
  try {
    assertCurrent();
    return assertCurrent;
  } catch (error) {
    options.respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, formatErrorMessage(error)));
    return undefined;
  }
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
