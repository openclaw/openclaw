import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileDisplay,
} from "../../../state/user-profiles.js";
import type { GatewayAuthResult } from "../../auth.js";
import type { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";
import { hasGatewayOperatorAccessPolicies } from "../../operator-access-policy.js";
import { formatForLog } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import { rejectUnavailableProfileConnect } from "./connect-admission.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

export function resolveAuthenticatedProfile(profileId: string, updatedAt: number) {
  const { id, displayName, avatarRevision, hasAvatar } = getUserProfileDisplay(profileId);
  return { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt };
}

async function resolveGatewayConnectUserProfile(params: {
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  authResult: GatewayAuthResult;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
}) {
  const profile = params.ownerProfileExpected
    ? ensureGatewayOwnerProfile(await resolveHostAccountName())
    : params.resolveAuthenticatedGitHubIdentity
      ? await params.resolveAuthenticatedGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? ensureProfileForTailscaleIdentity(params.authResult.tailscaleIdentity)
        : ensureProfileForEmail(params.authenticatedUserId!);
  const profileId = "profileId" in profile ? profile.profileId : profile.id;
  return resolveAuthenticatedProfile(profileId, profile.updatedAt);
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<GatewayConnectPhaseContext, "configSnapshot"> &
    Parameters<typeof rejectUnavailableProfileConnect>[0] & {
      handler: Pick<GatewayConnectPhaseContext["handler"], "connId" | "logWsControl">;
    };
  state: Pick<DeviceAuthorizedGatewayConnect, "authResult" | "role" | "authMethod">;
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
}): Promise<{ ok: true; profile?: GatewayWsClient["authenticatedUserProfile"] } | { ok: false }> {
  const { context, state, ownerProfileExpected, authenticatedUserId } = params;
  const profileRequired =
    Boolean(context.configSnapshot.gateway?.roles) ||
    hasGatewayOperatorAccessPolicies(context.configSnapshot);
  if (
    !ownerProfileExpected &&
    (!authenticatedUserId || (params.resolveAuthenticatedGitHubIdentity && !profileRequired))
  ) {
    return { ok: true };
  }
  try {
    const profile = await resolveGatewayConnectUserProfile({
      ownerProfileExpected,
      authenticatedUserId,
      authResult: state.authResult,
      resolveAuthenticatedGitHubIdentity: params.resolveAuthenticatedGitHubIdentity,
    });
    return { ok: true, profile };
  } catch (error) {
    context.handler.logWsControl.warn(
      `user profile resolution failed conn=${context.handler.connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
    );
    if (
      !ownerProfileExpected &&
      profileRequired &&
      state.role === "operator" &&
      state.authMethod !== "token" &&
      state.authMethod !== "password"
    ) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    return { ok: true };
  }
}
