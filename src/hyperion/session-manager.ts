import { DEFAULT_AGENT_ID, type HyperionPlatform } from "./types.js";

/**
 * Tenant-scoped session key management for Hyperion.
 * [claude-infra] Multi-instance: session keys now include agent_id.
 *
 * OpenClaw's sessions are identified by session keys (src/channels/session.ts,
 * src/routing/session-key.ts). In single-tenant mode, session keys are simple
 * channel identifiers like "telegram:12345" or "main".
 *
 * For multi-tenant Hyperion, all session keys are namespaced with the tenant's
 * user_id and agent_id to ensure complete isolation between tenants and agents:
 *
 *   Single-tenant OpenClaw: "main"
 *   Multi-tenant Hyperion:  "tenant_user123:main:main"
 *
 *   Single-tenant OpenClaw: "telegram:12345"
 *   Multi-tenant Hyperion:  "tenant_user123:main:telegram:12345"
 *
 * Format: tenant_{userId}:{agentId}:{rest}
 */

const TENANT_PREFIX = "tenant_";
const SEPARATOR = ":";

/**
 * Build a tenant-scoped session key for portal (synchronous) interactions.
 * [claude-infra] Multi-instance: includes agentId.
 *
 * @param userId - Internal Hyperion user ID
 * @param agentId - Agent instance ID (default: "main")
 * @returns Scoped session key like "tenant_user123:main:main"
 */
export function buildPortalSessionKey(userId: string, agentId: string = DEFAULT_AGENT_ID): string {
  return `${TENANT_PREFIX}${userId}${SEPARATOR}${agentId}${SEPARATOR}main`;
}

/**
 * Build a tenant-scoped session key for an external channel interaction.
 * [claude-infra] Multi-instance: includes agentId.
 *
 * @param userId - Internal Hyperion user ID
 * @param agentId - Agent instance ID (default: "main")
 * @param platform - External platform identifier
 * @param platformUserId - User's ID on the external platform
 * @param threadId - Optional thread/conversation ID for threaded sessions
 * @returns Scoped session key like "tenant_user123:main:telegram:98765"
 */
export function buildChannelSessionKey(
  userId: string,
  agentId: string = DEFAULT_AGENT_ID,
  platform: HyperionPlatform,
  platformUserId: string,
  threadId?: string,
): string {
  const base = `${TENANT_PREFIX}${userId}${SEPARATOR}${agentId}${SEPARATOR}${platform}${SEPARATOR}${platformUserId}`;
  if (threadId) {
    return `${base}${SEPARATOR}${threadId}`;
  }
  return base;
}

/**
 * Extract the tenant user_id from a scoped session key.
 *
 * @returns The user_id, or null if the key is not tenant-scoped.
 */
export function extractTenantId(sessionKey: string): string | null {
  if (!sessionKey.startsWith(TENANT_PREFIX)) {
    return null;
  }
  const afterPrefix = sessionKey.slice(TENANT_PREFIX.length);
  const separatorIdx = afterPrefix.indexOf(SEPARATOR);
  if (separatorIdx < 0) {
    return null;
  }
  return afterPrefix.slice(0, separatorIdx);
}

/**
 * Extract the agent_id from a scoped session key.
 * [claude-infra] Multi-instance support.
 *
 * Format: tenant_{userId}:{agentId}:{rest}
 * @returns The agent_id, or DEFAULT_AGENT_ID if not found.
 */
export function extractAgentId(sessionKey: string): string {
  if (!sessionKey.startsWith(TENANT_PREFIX)) {
    return DEFAULT_AGENT_ID;
  }
  const afterPrefix = sessionKey.slice(TENANT_PREFIX.length);
  const firstSep = afterPrefix.indexOf(SEPARATOR);
  if (firstSep < 0) {
    return DEFAULT_AGENT_ID;
  }
  const afterUserId = afterPrefix.slice(firstSep + 1);
  const secondSep = afterUserId.indexOf(SEPARATOR);
  if (secondSep < 0) {
    return afterUserId || DEFAULT_AGENT_ID;
  }
  return afterUserId.slice(0, secondSep) || DEFAULT_AGENT_ID;
}

/**
 * Extract the inner session key (without tenant prefix and agent_id).
 * This is what gets passed to OpenClaw's session internals.
 * [claude-infra] Multi-instance: strips both tenant_ prefix and agentId.
 *
 * @returns The inner key, or the original key if not tenant-scoped.
 */
export function extractInnerSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith(TENANT_PREFIX)) {
    return sessionKey;
  }
  const afterPrefix = sessionKey.slice(TENANT_PREFIX.length);
  // Skip userId
  const firstSep = afterPrefix.indexOf(SEPARATOR);
  if (firstSep < 0) {
    return sessionKey;
  }
  const afterUserId = afterPrefix.slice(firstSep + 1);
  // Skip agentId
  const secondSep = afterUserId.indexOf(SEPARATOR);
  if (secondSep < 0) {
    return afterUserId;
  }
  return afterUserId.slice(secondSep + 1);
}

/**
 * Check if a session key belongs to a specific tenant.
 */
export function isSessionForTenant(sessionKey: string, userId: string): boolean {
  return sessionKey.startsWith(`${TENANT_PREFIX}${userId}${SEPARATOR}`);
}

/**
 * Check if a session key belongs to a specific tenant+agent.
 * [claude-infra] Multi-instance support.
 */
export function isSessionForAgent(
  sessionKey: string,
  userId: string,
  agentId: string = DEFAULT_AGENT_ID,
): boolean {
  return sessionKey.startsWith(`${TENANT_PREFIX}${userId}${SEPARATOR}${agentId}${SEPARATOR}`);
}

/**
 * Build the AgentCore memory namespace for a tenant+agent.
 * [claude-infra] Multi-instance: each agent instance has isolated memory.
 */
export function buildTenantMemoryNamespace(
  userId: string,
  agentId: string = DEFAULT_AGENT_ID,
): string {
  return `${TENANT_PREFIX}${userId}${SEPARATOR}${agentId}`;
}
