import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import type { GatewayClient, GatewayRequestContext, GatewaySystemAgentSession } from "./types.js";

export async function evictOldestSystemAgentSession(
  sessions: Map<string, GatewaySystemAgentSession>,
  context: GatewayRequestContext,
): Promise<void> {
  if (sessions.size < 8) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    const oldest = sessions.get(oldestKey);
    if (oldest?.pendingApproval) {
      await context.systemAgentApprovalManager?.expire(
        oldest.pendingApproval.id,
        "session-evicted",
      );
    }
    await oldest?.engine.dispose();
    sessions.delete(oldestKey);
  }
}

export function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegation = params.delegation;
  const delegationKey = delegation
    ? JSON.stringify([delegation.agentId ?? null, delegation.sessionKey ?? null])
    : undefined;
  if (delegationKey !== undefined) {
    // Delegation is a host-only cross-connection owner from the regular-agent tool path.
    return delegationKey;
  }
  const profileId = params.client?.authenticatedUserProfile?.profileId.trim();
  if (profileId) {
    return `user:${profileId}`;
  }
  // A GitHub-backed connection has no durable owner until immutable profile sync succeeds.
  if (isGatewayClientProfilePending(params.client)) {
    return undefined;
  }
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}
