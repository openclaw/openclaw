// Session key utilities normalize and classify persisted session keys.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "@openclaw/session-url-contract/session-key-normalization";

export {
  normalizeSessionKeyPreservingOpaquePeerIds,
  normalizeSessionPeerId,
  parseAgentSessionKey,
  requiresFoldedSessionKeyAliasProof,
} from "@openclaw/session-url-contract/session-key-normalization";
export type { ParsedAgentSessionKey } from "@openclaw/session-url-contract";

export type ParsedThreadSessionSuffix = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};

type ParsedSessionDeliveryRoute = {
  accountId?: string;
  channel: string;
  peerId: string;
  peerKind: "channel" | "direct" | "dm" | "group";
  threadId?: string;
};

type ParsedCronRunScopeSuffix = {
  baseSessionKey: string | undefined;
  runId: string | undefined;
};

export type RawSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  prefix: string;
};

export function isCronRunSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return /^cron:[^:]+:run:[^:]+(?::|$)/.test(parsed.rest);
}

/**
 * Splits the terminal per-run `:run:<id>` scope off an isolated cron session key
 * (`agent:<id>:cron:<job>:run:<runId>`), yielding the cache-stable base key.
 * The run scope is only ever appended to cron keys, so this is gated to that exact
 * shape: any other key (including channel ids that embed a `:run:` segment) is returned
 * unchanged with `runId` undefined, never truncating an unrelated session identity.
 */
export function parseCronRunScopeSuffix(
  sessionKey: string | undefined | null,
): ParsedCronRunScopeSuffix {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return { baseSessionKey: undefined, runId: undefined };
  }
  const parsed = parseAgentSessionKey(raw);
  if (!parsed || !/^cron:[^:]+:run:[^:]+$/.test(parsed.rest)) {
    return { baseSessionKey: raw, runId: undefined };
  }
  const runMarker = ":run:";
  const markerIndex = raw.toLowerCase().lastIndexOf(runMarker);
  return {
    baseSessionKey: raw.slice(0, markerIndex),
    runId: raw.slice(markerIndex + runMarker.length),
  };
}

export function isCronSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return normalizeOptionalLowercaseString(parsed.rest)?.startsWith("cron:") === true;
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  if (normalizeOptionalLowercaseString(raw)?.startsWith("subagent:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeOptionalLowercaseString(parsed?.rest)?.startsWith("subagent:") === true;
}

export function getSubagentDepth(sessionKey: string | undefined | null): number {
  const raw = normalizeOptionalLowercaseString(sessionKey);
  if (!raw) {
    return 0;
  }

  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  const normalized = scoped.toLowerCase();
  const matches = normalized.match(/(^|:)subagent:/g);
  return matches?.length ?? 0;
}

export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (normalized.startsWith("acp:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeOptionalLowercaseString(parsed?.rest)?.startsWith("acp:") === true;
}

/** Stored ACP bindings and stale ACP keys both belong to ACP dispatch, never local fallback. */
export function resolveSessionDispatchKind(
  sessionKey: string | undefined | null,
  entry?: { acp?: unknown },
): "agent" | "acp" {
  return entry?.acp || isAcpSessionKey(sessionKey) ? "acp" : "agent";
}

export function parseThreadSessionSuffix(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return { baseSessionKey: undefined, threadId: undefined };
  }

  const lowerRaw = normalizeLowercaseStringOrEmpty(raw);
  const threadMarker = ":thread:";
  const threadIndex = lowerRaw.lastIndexOf(threadMarker);
  const markerIndex = threadIndex;
  const marker = threadMarker;

  const baseSessionKey = markerIndex === -1 ? raw : raw.slice(0, markerIndex);
  const threadIdRaw = markerIndex === -1 ? undefined : raw.slice(markerIndex + marker.length);
  const threadId = normalizeOptionalString(threadIdRaw);

  return { baseSessionKey, threadId };
}

const SESSION_DELIVERY_PEER_KINDS = new Set<ParsedSessionDeliveryRoute["peerKind"]>([
  "channel",
  "direct",
  "dm",
  "group",
]);

/** Parse only complete external delivery shapes; nested ownership stays opaque. */
export function parseSessionDeliveryRoute(
  sessionKey: string | undefined | null,
): ParsedSessionDeliveryRoute | null {
  const parsedThread = parseThreadSessionSuffix(sessionKey);
  const parsed = parseAgentSessionKey(parsedThread.baseSessionKey ?? sessionKey);
  if (!parsed) {
    return null;
  }
  const parts = parsed.rest.split(":");
  if (parts[0] === "agent" || parts.length < 3) {
    return null;
  }
  const channel = normalizeOptionalLowercaseString(parts[0]);
  if (!channel) {
    return null;
  }

  if (parts.length >= 4 && (parts[2] === "direct" || parts[2] === "dm")) {
    const accountId = normalizeOptionalString(parts[1]);
    const firstPeerIdSegment = normalizeOptionalString(parts[3]);
    const peerId = normalizeOptionalString(parts.slice(3).join(":"));
    if (!accountId || !firstPeerIdSegment || !peerId) {
      return null;
    }
    return {
      accountId,
      channel,
      peerId,
      peerKind: parts[2],
      threadId: parsedThread.threadId,
    };
  }

  const peerKind = parts[1] as ParsedSessionDeliveryRoute["peerKind"] | undefined;
  const firstPeerIdSegment = normalizeOptionalString(parts[2]);
  const peerId = normalizeOptionalString(parts.slice(2).join(":"));
  if (!peerKind || !SESSION_DELIVERY_PEER_KINDS.has(peerKind) || !firstPeerIdSegment || !peerId) {
    return null;
  }
  return { channel, peerId, peerKind, threadId: parsedThread.threadId };
}

export function parseRawSessionConversationRef(
  sessionKey: string | undefined | null,
): RawSessionConversationRef | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return null;
  }

  const rawParts = raw.split(":");
  // Only the outer ownership wrapper is authoritative for routing. Any inner
  // agent-shaped identity is opaque plugin input and must not inherit policy.
  const hasAgentWrapper = normalizeOptionalLowercaseString(rawParts[0]) === "agent";
  if (hasAgentWrapper && (!normalizeOptionalString(rawParts[1]) || rawParts.length < 3)) {
    return null;
  }
  const bodyStartIndex = hasAgentWrapper ? 2 : 0;
  const parts = rawParts.slice(bodyStartIndex);
  if (normalizeOptionalLowercaseString(parts[0]) === "agent") {
    return null;
  }
  // Empty opaque tail segments are valid (for example compressed IPv6), but
  // structural owner/channel/kind/first-id segments must be present.
  if (parts.length < 3 || !normalizeOptionalString(parts[2])) {
    return null;
  }

  const channel = normalizeOptionalLowercaseString(parts[0]);
  const kind = normalizeOptionalLowercaseString(parts[1]);
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
