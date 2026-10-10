import { randomUUID } from "node:crypto";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateSessionId } from "../../../config/sessions/paths.js";
import { isMainRestartRecoveryCandidate } from "../../../config/sessions/restart-recovery-state.js";
import {
  hasLegacySessionProviderState,
  LEGACY_SESSION_ENTRY_STATE_FIELDS,
  LEGACY_SESSION_PROVIDER_FIELDS,
} from "../../../config/sessions/session-entry-state-format.js";
import {
  normalizePendingFinalDelivery,
  normalizeFallbackNotice,
  normalizeMemoryFlush,
  projectCanonicalSessionEntryShape,
} from "../../../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : (asNonNegativeFiniteNumber(value) ?? 0);
}

function normalizeCount(value: unknown): number | undefined {
  const number = asNonNegativeFiniteNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}

/** Doctor retires legacy activity while preserving the previous writer's completed yield. */
export function migrateLegacySessionRunOutcome(
  value: Record<string, unknown>,
  sessionKey?: string,
  updatedAt: unknown = value.updatedAt,
): Record<string, unknown> {
  if (value.status !== "running" && value.status !== "queued") {
    return value;
  }
  const runId = normalizeOptionalString(value.lifecycleRunId);
  const terminalRuns = value.restartRecoveryTerminalRunIds;
  const delivered = value.restartRecoveryTerminalDeliveryEvidence;
  const hasNoTerminalEvidence =
    delivered === undefined ||
    (Array.isArray(delivered) &&
      delivered.every(
        (evidence) =>
          isRecord(evidence) && evidence.runId !== runId && evidence.transcriptRunId !== runId,
      ));
  const eligible = Boolean(
    sessionKey &&
    value.archivedAt === undefined &&
    value.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    isMainRestartRecoveryCandidate(value, sessionKey),
  );
  const startedAt = asNonNegativeFiniteNumber(value.startedAt);
  const endedAt = asNonNegativeFiniteNumber(value.endedAt);
  // Starts clear timing. An admitted recovery retains its own fence until its yielded end.
  const yielded =
    eligible &&
    value.status === "running" &&
    value.abortedLastRun === false &&
    runId &&
    value.lifecycleRunId === runId &&
    (value.activeWriterRunId === undefined || value.activeWriterRunId === runId) &&
    startedAt !== undefined &&
    endedAt !== undefined &&
    endedAt >= startedAt &&
    value.runtimeMs === endedAt - startedAt &&
    value.lastRunError === undefined &&
    !(Array.isArray(terminalRuns) && terminalRuns.includes(runId)) &&
    hasNoTerminalEvidence &&
    (value.restartRecoveryRuns === undefined ||
      (Array.isArray(value.restartRecoveryRuns) &&
        value.restartRecoveryRuns.every(
          (run) => isRecord(run) && typeof run.runId === "string" && run.runId !== runId,
        )));
  const next: Record<string, unknown> = {
    ...value,
    status: yielded ? undefined : "interrupted",
    abortedLastRun: !yielded,
    endedAt: endedAt ?? asNonNegativeFiniteNumber(updatedAt) ?? 0,
    lastRunError: yielded
      ? undefined
      : (normalizeOptionalString(value.lastRunError) ??
        "Run interrupted by a Gateway restart or loss."),
  };
  if (
    value.abortedLastRun === true &&
    runId &&
    value.lifecycleRunId === runId &&
    value.activeWriterRunId === runId &&
    isRecord(value.delivery) &&
    value.delivery.kind === "internal" &&
    !value.mainRestartRecovery &&
    !value.restartRecoveryDeliveryRunId &&
    !value.restartRecoveryDeliverySourceRunId &&
    !value.pendingFinalDelivery &&
    Array.isArray(terminalRuns) &&
    terminalRuns.includes(runId) &&
    hasNoTerminalEvidence
  ) {
    // Older command cleanup retired this exact undelivered source before recording its restart.
    next.restartRecoveryDeliveryRunId = runId;
    next.restartRecoveryDeliverySourceRunId = runId;
    const remaining = terminalRuns.filter((terminalRunId) => terminalRunId !== runId);
    next.restartRecoveryTerminalRunIds = remaining.length ? remaining : undefined;
  }
  if (
    value.status === "running" &&
    eligible &&
    !next.mainRestartRecovery &&
    !next.restartRecoveryDeliveryRunId &&
    !next.pendingFinalDelivery &&
    (next.restartRecoveryRuns === undefined ||
      (Array.isArray(next.restartRecoveryRuns) && next.restartRecoveryRuns.length === 0)) &&
    !(runId && Array.isArray(terminalRuns) && terminalRuns.includes(runId)) &&
    hasNoTerminalEvidence
  ) {
    // The previous writer used running as admission custody; transfer it before removing that signal.
    next.mainRestartRecovery = { cycleId: randomUUID(), revision: 1, chargedAttempts: 0 };
  }
  return next;
}

/** Doctor preserves July routing and scalar-state contracts before removing their old keys. */
export function migrateLegacySessionEntryState(
  value: Record<string, unknown>,
  updatedAt: unknown = value.updatedAt,
  sessionKey?: string,
): Record<string, unknown> {
  const next = { ...value };
  if (hasLegacySessionProviderState(value)) {
    for (const [legacy, current] of LEGACY_SESSION_PROVIDER_FIELDS) {
      if (typeof value[current] !== "string" && typeof value[legacy] === "string") {
        next[current] = value[legacy];
        delete next[legacy];
      }
    }
  }
  for (const field of LEGACY_SESSION_ENTRY_STATE_FIELDS) {
    delete next[field];
  }
  if (typeof value.pendingFinalDelivery === "boolean") {
    delete next.pendingFinalDelivery;
  }
  const text = normalizeOptionalString(value.pendingFinalDeliveryText);
  if (
    !normalizePendingFinalDelivery(value.pendingFinalDelivery) &&
    (text || value.pendingFinalDelivery === true)
  ) {
    const intentId = normalizeOptionalString(value.pendingFinalDeliveryIntentId);
    next.pendingFinalDelivery = {
      ...(text ? { kind: "replayable" as const, text } : { kind: "transport-only" as const }),
      createdAt:
        normalizeOptionalTimestamp(value.pendingFinalDeliveryCreatedAt) ??
        normalizeOptionalTimestamp(updatedAt) ??
        0,
      ...(isRecord(value.pendingFinalDeliveryContext)
        ? { context: value.pendingFinalDeliveryContext }
        : {}),
      ...(intentId ? { intentId } : {}),
    };
  }
  const selectedModel = normalizeOptionalString(value.fallbackNoticeSelectedModel);
  const activeModel = normalizeOptionalString(value.fallbackNoticeActiveModel);
  if (!normalizeFallbackNotice(value.fallbackNotice) && selectedModel && activeModel) {
    const reason = normalizeOptionalString(value.fallbackNoticeReason);
    next.fallbackNotice = {
      kind: "active",
      selectedModel,
      activeModel,
      ...(reason ? { reason } : {}),
    };
  }
  if (!normalizeMemoryFlush(value.memoryFlush)) {
    const compactionCount = normalizeCount(value.memoryFlushCompactionCount);
    const failureCount = normalizeCount(value.memoryFlushFailureCount);
    if (failureCount && failureCount > 0) {
      next.memoryFlush = {
        kind: "failed",
        ...(compactionCount !== undefined ? { compactionCount } : {}),
        failureCount,
      };
    } else if (compactionCount !== undefined) {
      next.memoryFlush = { kind: "succeeded", compactionCount };
    }
  }
  return migrateLegacySessionRunOutcome(next, sessionKey, updatedAt);
}

// Persisted stores may contain old or malformed ids; reject path-like ids before use.
function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255 || trimmed !== trimmed.normalize("NFC")) {
    return false;
  }
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._:@-]*$/u.test(trimmed);
}

function normalizeTranscriptSessionId(value: string): string | undefined {
  try {
    return validateSessionId(value);
  } catch {
    return undefined;
  }
}

/** Doctor and file import normalize persisted identities before publishing canonical rows. */
export function normalizePersistedSessionEntryShape(
  value: unknown,
  options: { sessionKey?: string } = {},
): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const modelSelectionLocked = value.modelSelectionLocked === true;
  let next = projectCanonicalSessionEntryShape(
    migrateLegacySessionEntryState(value, value.updatedAt, options.sessionKey),
  );
  if (value.sessionId !== undefined) {
    if (!isSafeSessionId(value.sessionId)) {
      return undefined;
    }
    const sessionId = value.sessionId.trim();
    const legacySessionFile = value.sessionFile;
    const pendingLegacyKeyId =
      !modelSelectionLocked &&
      options.sessionKey !== undefined &&
      parseAgentSessionKey(options.sessionKey) !== null &&
      sessionId === options.sessionKey &&
      (value.initializationPending === true ||
        typeof legacySessionFile !== "string" ||
        !legacySessionFile.trim());
    if (pendingLegacyKeyId) {
      const { sessionId: _legacyPendingSessionId, ...pendingEntry } = next;
      // SAFETY: Legacy import represents pending records as SessionEntry; initializationPending blocks admission until identity recovery.
      next = { ...pendingEntry, initializationPending: true } as SessionEntry;
    } else {
      if (modelSelectionLocked && sessionId !== value.sessionId) {
        // A harness lock protects the exact durable identity. Repairing it here
        // would make a corrupted row look valid before ownership validation.
        return undefined;
      }
      const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
      if (!transcriptSessionId) {
        return undefined;
      }
      if (sessionId !== value.sessionId) {
        next = { ...next, sessionId };
      }
    }
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}
