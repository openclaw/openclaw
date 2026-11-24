import { intersectOperatorScopes, roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileSelectionAuthority } from "../../state/user-channel-identity-operations.js";
import { currentOwnerDevicePrincipal } from "../openclaw-id/tunnel-principal.js";
import { hasCurrentGatewayOperatorAccess } from "../operator-access-policy.js";
import { operatorRoleSubject } from "../operator-role-enforcement.js";
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
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";
type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;
type PersonalProfileScope =
  | "operator.read"
  | "operator.write"
  | "operator.sessions.read"
  | "operator.admin";

/** Admit the role ceiling against the socket grant, preserving scope implications. */
export function currentPersonalProfileClient(
  options: Request,
  scope: PersonalProfileScope,
  owner?:
    | string
    | {
        profileId: string;
        role: string | null;
        githubLogin?: string | null;
        openclawIdAccountIds?: readonly string[];
      },
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
    throw new Error("This personal profile connection lost access. Reconnect and try again.");
  }
  if (!client) {
    return null;
  }
  if (isGatewayClientProfilePending(client)) {
    throw new Error("Authenticated profile verification is unavailable; retry the request.");
  }
  const cfg = context.getRuntimeConfig();
  const profileId = typeof owner === "string" ? owner : owner?.profileId;
  // An owner device attributed to its linked profile keeps owner authority (OCF-510) while
  // its owner certificate is current; a stale one falls back to the person's role.
  const policy =
    currentOwnerDevicePrincipal(client) !== undefined
      ? undefined
      : typeof owner === "object"
        ? resolveOperatorRolePolicyForAssignment(
            owner.profileId,
            owner.role,
            cfg,
            owner.githubLogin ?? null,
            operatorRoleSubject(owner),
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
    throw new Error(`Personal profile requires current ${scope} permission.`);
  }
  return {
    ...client,
    connect: { ...client.connect, scopes },
    ...(profileId && client.authenticatedUserProfile
      ? { authenticatedUserProfile: { ...client.authenticatedUserProfile, profileId } }
      : {}),
  };
}

/** Bind the authenticated credential owner once; retain only cancellation and owner isolation. */
export async function preparePersonalProfileAction(
  options: Request,
  scope: PersonalProfileScope = "operator.read",
  callerSignal?: AbortSignal,
): Promise<{
  owner: string;
  client: GatewayClient;
  signal: AbortSignal;
  assertCurrent: () => void;
}> {
  const { client, context } = options;
  const signal = AbortSignal.any(
    [options.signal, callerSignal].filter((source): source is AbortSignal => source !== undefined),
  );
  signal.throwIfAborted();
  if (!hasCurrentPersonalGatewaySource(client, context)) {
    throw new Error("Personal profile requires a current authenticated human Gateway connection.");
  }
  const profileReference = client.authenticatedUserProfile?.profileId;
  if (!profileReference) {
    throw new Error(
      "Personal profile requires a verified durable user profile; sign in and try again.",
    );
  }
  const profile = await prepareUserProfileSelectionAuthority(profileReference);
  signal.throwIfAborted();
  if (!profile) {
    throw new Error(
      "Personal profile requires a verified durable user profile; sign in and try again.",
    );
  }
  const admittedClient = currentPersonalProfileClient(options, scope, profile.profileId);
  if (!admittedClient) {
    throw new Error("Personal profile requires an authenticated Gateway connection.");
  }
  const owner = profile.profileId;
  const assertCurrent = () => {
    signal.throwIfAborted();
    // Never follow a merged profile to somebody else's credentials.
    if (!profile.isCurrent()) {
      throw new Error("Personal profile owner changed; retry from your current profile.");
    }
  };
  return { owner, client: admittedClient, signal, assertCurrent };
}
