// Session lifecycle timestamps prefer store metadata and fall back to transcript headers.
import {
  assertProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import {
  resolveIncognitoSessionExpiresAt,
  isIncognitoSessionKey,
} from "../../shared/incognito-session-key.js";
import {
  resolveTimestamp,
  resolveSessionLifecycleTimestampsWithHeader,
} from "./lifecycle-timestamps.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import { canonicalizeMainSessionAlias } from "./main-session.js";
import { loadTranscriptHeaderSync, readTranscriptMutationStateSync } from "./session-accessor.js";
import {
  isTerminalSessionStatus,
  type InternalSessionEntry,
  type SessionEntry,
  type SessionScope,
} from "./types.js";
export {
  createSessionWorkStartChangedError,
  isSessionWorkStartInvalidatedError,
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  SessionRestartRecoveryTombstoneError,
  SessionWorkStartChangedError,
  SessionWorkStartInvalidatedError,
} from "./work-start-error.js";

type SessionWorkStartEntry = Pick<
  InternalSessionEntry,
  | "archivedAt"
  | "createdAt"
  | "incognito"
  | "initializationPending"
  | "mainRestartRecovery"
  | "modelSelectionLocked"
  | "sessionId"
  | "pendingProjectGitUrl"
  | "pendingWorktree"
  | "providerReview"
  | "lifecycleRevision"
> &
  Partial<Pick<InternalSessionEntry, "updatedAt">>;

type SessionWorkStartOptions = {
  /** Already-accepted transcript/delivery results settle without dispatching new model work. */
  purpose?: "accepted-result-settlement";
  allowRestartTombstoneReplacement?: boolean;
  expectedSessionId?: string;
  /** Only workspace preparers and lifecycle cancellation may enter pending sessions. */
  allowPendingWorkspace?: true;
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  runId?: string;
};

export function isRestartRecoveryTombstone(
  entry: SessionWorkStartEntry | null | undefined,
): boolean {
  return entry?.mainRestartRecovery?.tombstone !== undefined;
}

/** Stable Gateway error detail for stale session lifecycle requests. */
export const SESSION_LIFECYCLE_CHANGED_ERROR_REASON = "session-changed";

/** Lifecycle-owned expired, initializing, restart-tombstoned, and archived sessions reject work. */
export function resolveSessionWorkStartError(
  sessionKey: string,
  entry: SessionWorkStartEntry | null | undefined,
  options?: SessionWorkStartOptions,
): string | undefined {
  if (options?.expectedSessionId && !entry) {
    return `Session "${sessionKey}" was deleted while starting work. Retry.`;
  }
  if (options?.expectedSessionId && entry?.sessionId !== options.expectedSessionId) {
    return `Session "${sessionKey}" changed while starting work. Retry.`;
  }
  const incognitoExpiresAt = entry ? resolveIncognitoSessionExpiresAt(entry) : undefined;
  if (
    (entry?.incognito || isIncognitoSessionKey(sessionKey)) &&
    incognitoExpiresAt !== undefined &&
    Date.now() >= incognitoExpiresAt
  ) {
    return `Incognito session "${sessionKey}" expired. Start a new Incognito session.`;
  }
  if (entry?.initializationPending === true) {
    return `Session "${sessionKey}" is still initializing. Retry after initialization completes.`;
  }
  if (entry?.providerReview && options?.purpose !== "accepted-result-settlement") {
    try {
      if (!options?.providerReviewAcknowledgment) {
        return `Session "${sessionKey}" is paused as a precaution. Review the provider findings in chat before continuing.`;
      }
      assertProviderReviewAcknowledgment(options.providerReviewAcknowledgment, {
        sessionKey,
        entry,
        runId: options.runId,
      });
    } catch {
      return `Session "${sessionKey}" provider review changed. Refresh the findings before continuing.`;
    }
  }
  const restartRecoveryTombstone = isRestartRecoveryTombstone(entry);
  if (restartRecoveryTombstone) {
    // Acknowledgment owns continuation of the reviewed conversation, never its replacement.
    if (options?.allowRestartTombstoneReplacement === true && !entry?.providerReview) {
      return undefined;
    }
    return entry?.modelSelectionLocked === true
      ? `Session "${sessionKey}" ended during restart recovery and cannot be replaced while model selection is locked. Open it in WebChat and use Resume in new session.`
      : `Session "${sessionKey}" ended during restart recovery. Use /new or /reset to start a replacement session.`;
  }
  if (entry?.archivedAt !== undefined) {
    return `Session "${sessionKey}" is archived. Restore it before starting new work.`;
  }
  if (
    !options?.allowPendingWorkspace &&
    (entry?.pendingProjectGitUrl !== undefined || entry?.pendingWorktree !== undefined)
  ) {
    return `Session "${sessionKey}" workspace is not ready. Wait for setup to finish or retry in chat.`;
  }
  return undefined;
}

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

function resolveTerminalMainSessionTranscriptRegistryCheck(
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
