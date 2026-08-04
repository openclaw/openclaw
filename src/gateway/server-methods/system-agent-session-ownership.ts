import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

const MAX_SYSTEM_AGENT_SESSIONS = 8;
const systemAgentSessionQueues = new WeakMap<
  Map<string, SystemAgentChatSession>,
  KeyedAsyncQueue
>();

export function getSystemAgentSessionQueue(
  sessions: Map<string, SystemAgentChatSession>,
): KeyedAsyncQueue {
  const existing = systemAgentSessionQueues.get(sessions);
  if (existing) {
    return existing;
  }
  const queue = new KeyedAsyncQueue();
  systemAgentSessionQueues.set(sessions, queue);
  return queue;
}

export function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Delegation is the host-only, cross-connection owner asserted by the regular-agent
    // tool path. Keep its agent/session tuple authoritative across gateway reconnects.
    return delegationKey;
  }
  // Authenticated users survive reconnects and may span paired devices. Otherwise
  // bind to the verified device, with the server-issued connection as a last resort.
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

export async function evictOldestSystemAgentSession(
  sessions: Map<string, SystemAgentChatSession>,
  context: GatewayRequestContext,
): Promise<boolean> {
  if (sessions.size < MAX_SYSTEM_AGENT_SESSIONS) {
    return true;
  }
  const protectedQrSessionByOwner = new Map<string, { key: string; lastUsedAt: number }>();
  for (const [key, session] of sessions) {
    if (!session.engine.hasPendingQrCode()) {
      continue;
    }
    const current = protectedQrSessionByOwner.get(session.ownerKey);
    // Map insertion order breaks same-millisecond ties so the later session is newest.
    if (!current || session.lastUsedAt >= current.lastUsedAt) {
      protectedQrSessionByOwner.set(session.ownerKey, { key, lastUsedAt: session.lastUsedAt });
    }
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    if (protectedQrSessionByOwner.get(session.ownerKey)?.key === key) {
      continue;
    }
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey === undefined) {
    return false;
  }
  const oldest = sessions.get(oldestKey);
  if (oldest?.pendingApproval) {
    context.systemAgentApprovalManager?.expire(oldest.pendingApproval.id, "session-evicted");
  }
  await oldest?.engine.dispose();
  sessions.delete(oldestKey);
  return true;
}
