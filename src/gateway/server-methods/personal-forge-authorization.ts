import { intersectOperatorScopes, roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { hasCurrentGatewayOperatorAccess } from "../operator-access-policy.js";
import {
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForProfile,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import {
  hasCurrentPersonalGatewaySource,
  isSyntheticGatewayCaller,
} from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;
export type PersonalForgeAction = { owner: string; signal: AbortSignal; assertCurrent: () => void };

/** Intersect the live role ceiling with the socket grant, preserving scope implications. */
export function currentPersonalForgeClient(
  options: Request,
  scope:
    | "operator.read"
    | "operator.write"
    | "operator.sessions.read"
    | "operator.sessions.write"
    | "operator.admin",
  owner?: string | { profileId: string; role: string | null; githubLogin?: string | null },
  label = "GitHub",
) {
  const { client, context } = options;
  if (
    options.signal?.aborted ||
    client?.invalidated ||
    client?.connectionSignal?.aborted ||
    !hasCurrentGatewayOperatorAccess(client?.internal?.operatorAccessAuthority) ||
    (client?.internal?.remoteIngressPrincipal &&
      !hasCurrentPersonalGatewaySource(client, context)) ||
    (client?.connId &&
      !isSyntheticGatewayCaller(client) &&
      !context.getClientConnIds?.((current) => current === client).has(client.connId))
  ) {
    throw new Error(`${label} request connection is no longer current; reconnect and try again.`);
  }
  if (!client) {
    return null;
  }
  if (isGatewayClientProfilePending(client)) {
    throw new Error("Authenticated profile verification is unavailable; retry the request.");
  }
  const cfg = context.getRuntimeConfig();
  const profileId = typeof owner === "string" ? owner : owner?.profileId;
  const policy =
    typeof owner === "object"
      ? resolveOperatorRolePolicyForAssignment(
          owner.profileId,
          owner.role,
          cfg,
          owner.githubLogin ?? null,
        )
      : profileId
        ? resolveOperatorRolePolicyForProfile(profileId, cfg)
        : resolveOperatorRolePolicy(client, cfg);
  const granted = client.connect.scopes ?? [];
  const scopes = policy ? intersectOperatorScopes(granted, policy.scopes) : granted;
  if (
    client.connect.role !== "operator" ||
    !roleScopesAllow({
      role: "operator",
      requestedScopes: [scope],
      allowedScopes: scopes,
    })
  ) {
    throw new Error(`${label} requires current ${scope} permission.`);
  }
  return {
    ...client,
    connect: { ...client.connect, scopes },
    ...(profileId && client.authenticatedUserProfile
      ? { authenticatedUserProfile: { ...client.authenticatedUserProfile, profileId } }
      : {}),
  };
}

/** Prepare canonical role facts off-thread; live checks consume the profile owner's revisions. */
export async function preparePersonalForgeAction(
  options: Request,
  scope: "operator.read" | "operator.write" | "operator.admin" = "operator.read",
  callerSignal?: AbortSignal,
  label = "GitHub",
): Promise<PersonalForgeAction> {
  const { client, context } = options;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const access = client?.internal?.operatorAccessAuthority;
  const signals = [options.signal, callerSignal, client?.connectionSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const assertConnection = () => {
    signal.throwIfAborted();
    if (!hasCurrentPersonalGatewaySource(client, context)) {
      throw new Error(`My ${label} requires a current authenticated human Gateway connection.`);
    }
    if (
      client.authenticatedUserProfile?.profileId !== profileReference ||
      client.authenticatedUserId !== userId ||
      client.internal?.operatorAccessAuthority !== access
    ) {
      throw new Error(`My ${label} owner changed; retry from your current profile.`);
    }
  };
  assertConnection();
  const profile = profileReference
    ? await prepareUserProfileRolePolicyAuthority(profileReference)
    : undefined;
  assertConnection();
  if (!profile) {
    throw new Error(`My ${label} requires a verified durable user profile; sign in and try again.`);
  }
  const assertCurrent = () => {
    assertConnection();
    if (!profile.isCurrent()) {
      throw new Error(`My ${label} owner changed; retry from your current profile.`);
    }
    currentPersonalForgeClient(options, scope, profile, label);
  };
  assertCurrent();
  return { owner: profile.profileId, signal, assertCurrent };
}
