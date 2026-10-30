import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readSessionTranscriptHeaderStartedAt } from "./transcript-header.js";
import type { SessionEntry } from "./types.js";

type SessionLifecycleEntry = Pick<
  SessionEntry,
  "sessionId" | "sessionStartedAt" | "lastInteractionAt" | "updatedAt"
>;

export function resolveTimestamp(value: number | undefined): number | undefined {
  const timestampMs = asDateTimestampMs(value);
  return timestampMs !== undefined && timestampMs >= 0 ? timestampMs : undefined;
}

function readSessionHeaderStartedAtMs(params: {
  entry: SessionLifecycleEntry;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  readHeader: (scope: SessionTranscriptReadScope) => unknown;
}): number | undefined {
  const sessionId = params.entry.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  const agentId =
    params.agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
  if (!sessionId || !agentId) {
    return undefined;
  }
  try {
    const header = params.readHeader({
      agentId,
      sessionId,
      ...(params.storePath ? { storePath: params.storePath } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    });
    return readSessionTranscriptHeaderStartedAt(header, sessionId);
  } catch {
    return undefined;
  }
}

export function resolveSessionLifecycleTimestampsWithHeader(params: {
  entry: SessionLifecycleEntry | undefined;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  readHeader: (scope: SessionTranscriptReadScope) => unknown;
}): SessionLifecycleTimestamps {
  const entry = params.entry;
  if (!entry) {
    return {};
  }
  return {
    sessionStartedAt:
      resolveTimestamp(entry.sessionStartedAt) ??
      readSessionHeaderStartedAtMs({ ...params, entry }),
    lastInteractionAt: resolveTimestamp(entry.lastInteractionAt),
  };
}
