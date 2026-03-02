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

export type SessionThreadMarker = "thread" | "topic";

type ThreadMarkerConfig = {
  marker: SessionThreadMarker;
  needle: string;
};

const THREAD_SESSION_MARKERS: ThreadMarkerConfig[] = [
  { marker: "thread", needle: ":thread:" },
  { marker: "topic", needle: ":topic:" },
];

export function resolveSessionThreadInfo(sessionKey: string | undefined | null): {
  marker: SessionThreadMarker | null;
  parentSessionKey: string | null;
  threadId: string | null;
} {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return {
      marker: null,
      parentSessionKey: null,
      threadId: null,
    };
  }

  const normalized = raw.toLowerCase();
  let best: { marker: SessionThreadMarker; index: number; needle: string } | null = null;
  for (const marker of THREAD_SESSION_MARKERS) {
    const index = normalized.lastIndexOf(marker.needle);
    if (index < 0) {
      continue;
    }
    if (!best || index > best.index) {
      best = { marker: marker.marker, index, needle: marker.needle };
    }
  }

  if (!best || best.index <= 0) {
    return {
      marker: null,
      parentSessionKey: null,
      threadId: null,
    };
  }

  const parentSessionKey = raw.slice(0, best.index).trim();
  const threadIdRaw = raw.slice(best.index + best.needle.length).trim();
  return {
    marker: best.marker,
    parentSessionKey: parentSessionKey || null,
    threadId: threadIdRaw || null,
  };
}

export function resolveThreadParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  return resolveSessionThreadInfo(sessionKey).parentSessionKey;
}
