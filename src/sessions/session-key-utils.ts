export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";

/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are normalized to lowercase for stable comparisons/routing.
 */
export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  if (parts[0] !== "agent") {
    return null;
  }
  const agentId = parts[1]?.trim();
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
}

/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return "unknown";
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const tokens = new Set(scoped.split(":").filter(Boolean));
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm") || tokens.has("dm-named")) {
    return "direct";
  }
  // Legacy Discord keys can be shaped like:
  // discord:<accountId>:guild-<guildId>:channel-<channelId>
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scoped)) {
    return "channel";
  }
  return "unknown";
}

export function isCronRunSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return /^cron:[^:]+:run:[^:]+$/.test(parsed.rest);
}

export function isCronSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return parsed.rest.toLowerCase().startsWith("cron:");
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return false;
  }
  if (raw.toLowerCase().startsWith("subagent:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return Boolean((parsed?.rest ?? "").toLowerCase().startsWith("subagent:"));
}

export function getSubagentDepth(sessionKey: string | undefined | null): number {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return 0;
  }
  return raw.split(":subagent:").length - 1;
}

export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return false;
  }
  const normalized = raw.toLowerCase();
  if (normalized.startsWith("acp:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return Boolean((parsed?.rest ?? "").toLowerCase().startsWith("acp:"));
}

const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];

export function resolveThreadParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.toLowerCase();
  let idx = -1;
  for (const marker of THREAD_SESSION_MARKERS) {
    const candidate = normalized.lastIndexOf(marker);
    if (candidate > idx) {
      idx = candidate;
    }
  }
  if (idx <= 0) {
    return null;
  }
  const parent = raw.slice(0, idx).trim();
  return parent ? parent : null;
}

/**
 * Check if a session key is a named DM session key.
 * Format: agent:main:dm-named:<peerId>:<name>
 */
export function isNamedDmSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return /^dm-named:[^:]+:[^:]+$/.test(parsed.rest);
}

/**
 * Build a named DM session key.
 * Format: agent:<agentId>:dm-named:<peerId>:<name>
 */
export function buildNamedDmSessionKey(params: {
  agentId: string;
  peerId: string;
  name: string;
}): string {
  const agentId = params.agentId.trim().toLowerCase();
  const peerId = params.peerId.trim().toLowerCase();
  const name = params.name.trim().toLowerCase();
  if (!agentId || !peerId || !name) {
    throw new Error("buildNamedDmSessionKey: agentId, peerId, and name are required");
  }
  if (agentId.includes(":")) {
    throw new Error(`buildNamedDmSessionKey: agentId must not contain ":" (got: "${agentId}")`);
  }
  if (peerId.includes(":")) {
    throw new Error(`buildNamedDmSessionKey: peerId must not contain ":" (got: "${peerId}")`);
  }
  if (name.includes(":")) {
    throw new Error(`buildNamedDmSessionKey: name must not contain ":" (got: "${name}")`);
  }
  return `agent:${agentId}:dm-named:${peerId}:${name}`;
}

/**
 * Parse a named DM session key.
 * Returns { agentId, peerId, name } or null if not a named DM key.
 */
export function parseNamedDmSessionKey(
  sessionKey: string | undefined | null,
): { agentId: string; peerId: string; name: string } | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const parts = parsed.rest.split(":");
  if (parts.length !== 3) {
    return null;
  }
  if (parts[0] !== "dm-named") {
    return null;
  }
  const peerId = parts[1]?.trim();
  const name = parts[2]?.trim();
  if (!peerId || !name) {
    return null;
  }
  return {
    agentId: parsed.agentId,
    peerId,
    name,
  };
}
