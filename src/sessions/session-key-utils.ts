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
const NON_CHANNEL_SCOPES = new Set(["main", "cron", "subagent", "acp"]);

function hasThreadSessionMarker(value: string): boolean {
  return THREAD_SESSION_MARKERS.some((marker) => value.includes(marker));
}

function resolveScopedChannel(params: {
  sessionKey: string | undefined | null;
  channelHint?: string | null;
}): string | null {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const normalizedHint = (params.channelHint ?? "").trim().toLowerCase();
  const parsed = parseAgentSessionKey(raw);
  const scoped = (parsed?.rest ?? raw).toLowerCase();
  const head = scoped.split(":")[0]?.trim() ?? "";
  if (head && !NON_CHANNEL_SCOPES.has(head)) {
    return head;
  }
  return normalizedHint || null;
}

function hasCompatibleThreadScope(params: {
  sessionKey: string | undefined | null;
  parentSessionKey: string | undefined | null;
  channelHint?: string | null;
}): boolean {
  const sessionChannel = resolveScopedChannel({
    sessionKey: params.sessionKey,
    channelHint: params.channelHint,
  });
  const parentChannel = resolveScopedChannel({
    sessionKey: params.parentSessionKey,
    channelHint: params.channelHint,
  });
  if (!sessionChannel || !parentChannel) {
    return false;
  }
  return sessionChannel === parentChannel;
}

function isAmbiguousMainScopedNonTelegramThread(params: {
  sessionKey: string | undefined | null;
  channelHint?: string | null;
}): boolean {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return false;
  }
  const scoped = (parseAgentSessionKey(raw)?.rest ?? raw).toLowerCase();
  if (!scoped.startsWith("main:")) {
    return false;
  }
  if (!hasThreadSessionMarker(scoped)) {
    return false;
  }
  const channelHint = (params.channelHint ?? "").trim().toLowerCase();
  return channelHint !== "telegram";
}

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

function resolveTelegramChatRoot(params: {
  sessionKey: string | undefined | null;
  allowMainScopedThreads: boolean;
}): string | null {
  const { sessionKey, allowMainScopedThreads } = params;
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = parseAgentSessionKey(raw);
  const scoped = (parsed?.rest ?? raw).toLowerCase();
  if (!scoped.startsWith("telegram:")) {
    if (!allowMainScopedThreads) {
      return null;
    }
    if (!scoped.startsWith("main:") && scoped !== "main") {
      return null;
    }
  }
  const hasThreadMarker = scoped.includes(":thread:") || scoped.includes(":topic:");
  if (!hasThreadMarker) {
    if (scoped === "main" && allowMainScopedThreads) {
      return "main";
    }
    if (!scoped.startsWith("telegram:")) {
      return null;
    }
  }
  if (!scoped.startsWith("telegram:") && !allowMainScopedThreads) {
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
  channelHint?: string | null;
}): string | null {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }

  const parsed = parseAgentSessionKey(raw);
  const scoped = (parsed?.rest ?? raw).toLowerCase();
  if (!scoped.includes(":thread:") && !scoped.includes(":topic:")) {
    return null;
  }
  const channelHint = (params.channelHint ?? "").trim().toLowerCase();
  const allowMainScopedThreads = channelHint === "telegram";
  if (!scoped.startsWith("telegram:") && !allowMainScopedThreads) {
    return null;
  }

  const sessionChatRoot = resolveTelegramChatRoot({
    sessionKey: raw,
    allowMainScopedThreads,
  });
  if (!sessionChatRoot) {
    return null;
  }

  const explicitParent = (params.parentSessionKey ?? "").trim();
  if (explicitParent && explicitParent !== raw) {
    const explicitParentRoot = resolveTelegramChatRoot({
      sessionKey: explicitParent,
      allowMainScopedThreads,
    });
    if (explicitParentRoot && explicitParentRoot === sessionChatRoot) {
      return explicitParent;
    }
  }

  const derivedParent = resolveThreadParentSessionKey(raw);
  if (!derivedParent || derivedParent === raw) {
    return null;
  }
  const derivedParentRoot = resolveTelegramChatRoot({
    sessionKey: derivedParent,
    allowMainScopedThreads,
  });
  if (!derivedParentRoot || derivedParentRoot !== sessionChatRoot) {
    return null;
  }
  return derivedParent;
}

/**
 * Resolve parent session key for future-thread default inheritance.
 * Priority:
 * 1) explicit parent session key (for channels where thread sessions do not carry suffix markers)
 * 2) Telegram-specific resolver (includes main-scoped Telegram threads)
 * 3) generic :thread:/:topic: suffix fallback
 */
export function resolveFutureThreadParentSessionKey(params: {
  sessionKey: string | undefined | null;
  parentSessionKey?: string | null;
  channelHint?: string | null;
}): string | null {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }

  const channelHint = (params.channelHint ?? "").trim().toLowerCase();
  const explicitParent = (params.parentSessionKey ?? "").trim();
  if (explicitParent && explicitParent !== raw) {
    const rawParsed = parseAgentSessionKey(raw);
    const explicitParsed = parseAgentSessionKey(explicitParent);
    const sameAgentScope =
      !rawParsed || !explicitParsed || rawParsed.agentId === explicitParsed.agentId;
    if (
      sameAgentScope &&
      !isAmbiguousMainScopedNonTelegramThread({ sessionKey: raw, channelHint }) &&
      hasCompatibleThreadScope({
        sessionKey: raw,
        parentSessionKey: explicitParent,
        channelHint,
      })
    ) {
      return explicitParent;
    }
  }

  const telegramParent = resolveTelegramThreadParentSessionKey({
    sessionKey: raw,
    parentSessionKey: params.parentSessionKey,
    channelHint,
  });
  if (telegramParent) {
    return telegramParent;
  }

  if (isAmbiguousMainScopedNonTelegramThread({ sessionKey: raw, channelHint })) {
    return null;
  }

  const derivedParent = resolveThreadParentSessionKey(raw);
  if (!derivedParent || derivedParent === raw) {
    return null;
  }
  if (
    !hasCompatibleThreadScope({
      sessionKey: raw,
      parentSessionKey: derivedParent,
      channelHint,
    })
  ) {
    return null;
  }
  return derivedParent;
}
