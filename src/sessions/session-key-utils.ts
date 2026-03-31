export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";
export type ParsedThreadSessionSuffix = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};

export type ParsedSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  id: string;
  threadId: string | undefined;
};

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

function normalizeThreadSuffixChannelHint(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed || undefined;
}

function inferThreadSuffixChannelHint(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":").filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  if ((parts[0] ?? "").trim().toLowerCase() === "agent") {
    return normalizeThreadSuffixChannelHint(parts[2]);
  }
  return normalizeThreadSuffixChannelHint(parts[0]);
}

export function parseThreadSessionSuffix(
  sessionKey: string | undefined | null,
  options?: { channelHint?: string | null },
): ParsedThreadSessionSuffix {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return { baseSessionKey: undefined, threadId: undefined };
  }

  const channelHint =
    normalizeThreadSuffixChannelHint(options?.channelHint) ?? inferThreadSuffixChannelHint(raw);
  const lowerRaw = raw.toLowerCase();
  const topicMarker = ":topic:";
  const threadMarker = ":thread:";
  const topicIndex = channelHint === "telegram" ? lowerRaw.lastIndexOf(topicMarker) : -1;
  const threadIndex = lowerRaw.lastIndexOf(threadMarker);
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? topicMarker : threadMarker;

  const baseSessionKey = markerIndex === -1 ? raw : raw.slice(0, markerIndex);
  const threadIdRaw = markerIndex === -1 ? undefined : raw.slice(markerIndex + marker.length);
  const threadId = threadIdRaw?.trim() || undefined;

  return { baseSessionKey, threadId };
}

export function parseSessionConversationRef(
  sessionKey: string | undefined | null,
): ParsedSessionConversationRef | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }

  const rawParts = raw.split(":").filter(Boolean);
  const parts =
    rawParts.length >= 3 && rawParts[0]?.trim().toLowerCase() === "agent"
      ? rawParts.slice(2)
      : rawParts;
  if (parts.length < 3) {
    return null;
  }

  const channel = normalizeThreadSuffixChannelHint(parts[0]);
  const kind = parts[1]?.trim().toLowerCase();
  if (!channel || (kind !== "group" && kind !== "channel")) {
    return null;
  }

  const joined = parts.slice(2).join(":");
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(joined, {
    channelHint: channel,
  });
  const id = (baseSessionKey ?? joined).trim();
  if (!id) {
    return null;
  }

  return { channel, kind, id, threadId };
}

export function resolveThreadParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(sessionKey);
  if (!threadId) {
    return null;
  }
  const parent = baseSessionKey?.trim();
  if (!parent) {
    return null;
  }
  return parent;
}
