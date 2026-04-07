import { normalizeOptionalString } from "../shared/string-coerce.js";

export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export type ParsedThreadSessionSuffix = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};

export type RawSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  prefix: string;
};

/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are normalized to lowercase for stable comparisons/routing.
 */
export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  const raw = normalizeOptionalString(sessionKey)?.toLowerCase();
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
  const agentId = normalizeOptionalString(parts[1]);
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
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
  const raw = normalizeOptionalString(sessionKey);
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
  const raw = normalizeOptionalString(sessionKey)?.toLowerCase();
  if (!raw) {
    return 0;
  }
  return raw.split(":subagent:").length - 1;
}

export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
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

export function parseThreadSessionSuffix(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return { baseSessionKey: undefined, threadId: undefined };
  }

  const lowerRaw = raw.toLowerCase();
  const threadMarker = ":thread:";
  const threadIndex = lowerRaw.lastIndexOf(threadMarker);
  const markerIndex = threadIndex;
  const marker = threadMarker;

  const baseSessionKey = markerIndex === -1 ? raw : raw.slice(0, markerIndex);
  const threadIdRaw = markerIndex === -1 ? undefined : raw.slice(markerIndex + marker.length);
  const threadId = normalizeOptionalString(threadIdRaw);

  return { baseSessionKey, threadId };
}

export function parseRawSessionConversationRef(
  sessionKey: string | undefined | null,
): RawSessionConversationRef | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return null;
  }

  const rawParts = raw.split(":").filter(Boolean);
  const bodyStartIndex =
    rawParts.length >= 3 && normalizeOptionalString(rawParts[0])?.toLowerCase() === "agent" ? 2 : 0;
  const parts = rawParts.slice(bodyStartIndex);
  if (parts.length < 3) {
    return null;
  }

  const channel = normalizeOptionalString(parts[0])?.toLowerCase();
  const kind = normalizeOptionalString(parts[1])?.toLowerCase();
  if (!channel || (kind !== "group" && kind !== "channel")) {
    return null;
  }

  const rawId = normalizeOptionalString(parts.slice(2).join(":"));
  const prefix = normalizeOptionalString(rawParts.slice(0, bodyStartIndex + 2).join(":"));
  if (!rawId || !prefix) {
    return null;
  }

  return { channel, kind, rawId, prefix };
}

export function resolveThreadParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(sessionKey);
  if (!threadId) {
    return null;
  }
  const parent = normalizeOptionalString(baseSessionKey);
  if (!parent) {
    return null;
  }
  return parent;
}
