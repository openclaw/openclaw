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
  if (tokens.has("direct") || tokens.has("dm")) {
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

function resolveTelegramChatRoot(sessionKey: string | undefined | null): string | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = parseAgentSessionKey(raw);
  const scoped = (parsed?.rest ?? raw).toLowerCase();
  if (!scoped.startsWith("telegram:")) {
    return null;
  }
  const threadIndex = scoped.indexOf(":thread:");
  const topicIndex = scoped.indexOf(":topic:");
  const cutIndex =
    threadIndex >= 0 && topicIndex >= 0
      ? Math.min(threadIndex, topicIndex)
      : threadIndex >= 0
        ? threadIndex
        : topicIndex;
  return (cutIndex >= 0 ? scoped.slice(0, cutIndex) : scoped).trim() || null;
}

/**
 * Resolve parent session key for Telegram thread/topic sessions only.
 * Returns null for non-Telegram sessions so callers can avoid cross-channel
 * side effects when applying thread-default behavior.
 */
export function resolveTelegramThreadParentSessionKey(params: {
  sessionKey: string | undefined | null;
  parentSessionKey?: string | null;
}): string | null {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }

  const parsed = parseAgentSessionKey(raw);
  const scoped = (parsed?.rest ?? raw).toLowerCase();
  if (!scoped.startsWith("telegram:")) {
    return null;
  }
  if (!scoped.includes(":thread:") && !scoped.includes(":topic:")) {
    return null;
  }
  const sessionChatRoot = resolveTelegramChatRoot(raw);
  if (!sessionChatRoot) {
    return null;
  }

  const explicitParent = (params.parentSessionKey ?? "").trim();
  if (explicitParent && explicitParent !== raw) {
    const explicitParentRoot = resolveTelegramChatRoot(explicitParent);
    if (explicitParentRoot && explicitParentRoot === sessionChatRoot) {
      return explicitParent;
    }
  }

  const derivedParent = resolveThreadParentSessionKey(raw);
  if (!derivedParent || derivedParent === raw) {
    return null;
  }
  const derivedParentRoot = resolveTelegramChatRoot(derivedParent);
  if (!derivedParentRoot || derivedParentRoot !== sessionChatRoot) {
    return null;
  }
  return derivedParent;
}
