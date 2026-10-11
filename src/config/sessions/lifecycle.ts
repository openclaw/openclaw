// Session lifecycle timestamps prefer store metadata and fall back to transcript headers.
import {
  resolveTimestamp,
  resolveSessionLifecycleTimestampsWithHeader,
} from "./lifecycle-timestamps.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import { canonicalizeMainSessionAlias } from "./main-session.js";
import { loadTranscriptHeaderSync, readTranscriptMutationStateSync } from "./session-accessor.js";
import { isTerminalSessionStatus, type SessionEntry, type SessionScope } from "./types.js";
export {
  createSessionWorkStartChangedError,
  isSessionWorkStartInvalidatedError,
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  SessionRestartRecoveryTombstoneError,
  SessionWorkStartChangedError,
  SessionWorkStartInvalidatedError,
} from "./work-start-error.js";

export {
  isRestartRecoveryTombstone,
  resolveSessionWorkStartError,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
} from "./session-work-start.js";

// Transcript headers are read lazily to recover startedAt without parsing full files.

type TerminalMainSessionTranscriptRegistryParams = {
  entry: SessionEntry | undefined;
  sessionScope?: SessionScope;
  sessionKey?: string;
  agentId: string;
  mainKey?: string;
  storePath?: string;
};

type TerminalMainSessionTranscriptRegistryCheck = {
  sessionId: string;
  registryTimestampMs: number;
};

function resolvePositiveTimestamp(value: number | undefined): number | undefined {
  const timestampMs = resolveTimestamp(value);
  return timestampMs !== undefined && timestampMs > 0 ? timestampMs : undefined;
}

export function resolveSessionLifecycleTimestamps(params: {
  entry: Parameters<typeof resolveSessionLifecycleTimestampsWithHeader>[0]["entry"];
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  readHeader?: (sessionId: string) => unknown;
}): SessionLifecycleTimestamps {
  return resolveSessionLifecycleTimestampsWithHeader({
    ...params,
    readHeader: (scope) =>
      params.readHeader ? params.readHeader(scope.sessionId) : loadTranscriptHeaderSync(scope),
  });
}

export function resolveTerminalMainSessionTranscriptRegistryCheck(
  params: TerminalMainSessionTranscriptRegistryParams,
): TerminalMainSessionTranscriptRegistryCheck | undefined {
  if (!params.entry || !params.sessionKey) {
    return undefined;
  }
  const configuredMainSessionKey = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.sessionScope, mainKey: params.mainKey } },
    agentId: params.agentId,
    sessionKey: params.mainKey ?? "main",
  });
  const candidateSessionKey = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.sessionScope, mainKey: params.mainKey } },
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (candidateSessionKey !== configuredMainSessionKey) {
    return undefined;
  }
  if (!isTerminalSessionStatus(params.entry.status)) {
    return undefined;
  }
  if (params.entry.status === "done") {
    // Successful rows stay reusable: transcript writes can land after registry
    // updates without making the session stale.
    return undefined;
  }
  if (params.entry.status === "failed") {
    // Failed rows with a present transcript stay reusable for retry/recovery.
    // Callers already rotate failed rows when the transcript is missing.
    return undefined;
  }
  // updatedAt is touched after managed transcript appends; endedAt can predate
  // healthy post-run transcript writes and would rotate valid sessions.
  const registryTimestampMs = resolvePositiveTimestamp(params.entry.updatedAt);
  if (registryTimestampMs === undefined) {
    return undefined;
  }
  const sessionId = typeof params.entry.sessionId === "string" ? params.entry.sessionId.trim() : "";
  if (!sessionId) {
    return undefined;
  }
  return { sessionId, registryTimestampMs };
}

export function hasTerminalMainSessionTranscriptNewerThanRegistrySync(
  params: TerminalMainSessionTranscriptRegistryParams,
): boolean {
  const check = resolveTerminalMainSessionTranscriptRegistryCheck(params);
  if (!check) {
    return false;
  }
  try {
    // Runtime transcripts are SQLite-only. Legacy-looking sessionFile values still
    // resolve through agent/session/store scope, so a file stat would read stale state.
    const mutation = readTranscriptMutationStateSync({
      agentId: params.agentId,
      sessionId: check.sessionId,
      storePath: params.storePath,
    });
    if (mutation.updatedAt === null) {
      return false;
    }
    const transcriptMutationAtMs = Math.floor(mutation.updatedAt);
    const registryTimestampMs = Math.floor(mutation.observedAt ?? check.registryTimestampMs);
    return Number.isFinite(transcriptMutationAtMs) && transcriptMutationAtMs > registryTimestampMs;
  } catch {
    return false;
  }
}
