import {
  asNonNegativeFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validateSessionId } from "../../../config/sessions/paths.js";
import { admitCanonicalSessionEntry } from "../../../config/sessions/session-entry-json.js";
import {
  SESSION_ENTRY_NUMERIC_FIELDS,
  type SessionEntryNumericSnapshot,
} from "../../../config/sessions/session-entry-numeric-snapshot.js";
import {
  hasLegacySessionProviderState,
  LEGACY_SESSION_ENTRY_STATE_FIELDS,
  LEGACY_SESSION_PROVIDER_FIELDS,
} from "../../../config/sessions/session-entry-state-format.js";
import {
  normalizeCount,
  normalizeFallbackNotice,
  normalizeMemoryFlush,
  normalizeOptionalTimestamp,
  normalizePendingFinalDelivery,
} from "../../../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { hasAgentRunContextExecutionOwner } from "../../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";

export type SessionEntryStateRepair = {
  entry: Record<string, unknown>;
  numericChanges?: SessionEntryNumericSnapshot;
};

/** A dead owner is not proof that its custody belongs to this recovery cycle. */
export function inspectLegacyRestartTombstone(
  value: Record<string, unknown>,
): { retire: boolean; doctorOnly?: true; warning: string } | undefined {
  if (!isRecord(value.mainRestartRecovery) || !isRecord(value.mainRestartRecovery.tombstone)) {
    return undefined;
  }
  const recovery = value.mainRestartRecovery;
  const execution = isRecord(recovery.executionIdentity) ? recovery.executionIdentity : undefined;
  const reservation = isRecord(recovery.reservation) ? recovery.reservation : undefined;
  const claims = isRecord(recovery.foregroundClaims) ? recovery.foregroundClaims : undefined;
  const runIds = new Set(
    [
      execution?.runId,
      reservation?.runId,
      ...Object.values(isRecord(claims?.runIdsByClaimId) ? claims.runIdsByClaimId : {}),
    ].filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const generations = new Set(
    [reservation?.lifecycleGeneration, claims?.lifecycleGeneration].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  const runs = Array.isArray(value.restartRecoveryRuns) ? value.restartRecoveryRuns : [];
  // An execution identity inside the cycle can bind its recorded fence generation.
  // Explicit cycle generations win if a run ID was reused by a later generation.
  if (generations.size === 0) {
    for (const run of runs) {
      if (
        isRecord(run) &&
        typeof run.runId === "string" &&
        runIds.has(run.runId) &&
        typeof run.lifecycleGeneration === "string"
      ) {
        generations.add(run.lifecycleGeneration);
      }
    }
  }
  const ownsFence = (run: unknown): boolean =>
    isRecord(run) &&
    (run.lifecycleGeneration !== undefined && generations.size > 0
      ? typeof run.lifecycleGeneration === "string" && generations.has(run.lifecycleGeneration)
      : typeof run.runId === "string" && runIds.has(run.runId));
  const ownsRun = (id: unknown): boolean =>
    typeof id === "string" &&
    (runIds.has(id) || runs.some((run) => isRecord(run) && run.runId === id && ownsFence(run)));
  const custodyIds = [
    value.activeWriterRunId,
    value.lifecycleRunId,
    value.restartRecoveryDeliveryRunId,
    value.restartRecoveryDeliverySourceRunId,
    ...runs.map((run) => (isRecord(run) ? run.runId : undefined)),
    ...(Array.isArray(value.restartRecoveryTerminalRunIds)
      ? value.restartRecoveryTerminalRunIds
      : []),
    ...(Array.isArray(value.restartRecoveryTerminalDeliveryEvidence)
      ? value.restartRecoveryTerminalDeliveryEvidence.flatMap((item) =>
          isRecord(item) ? [item.runId, item.transcriptRunId] : [null],
        )
      : []),
    isRecord(value.restartRecoveryOperatorSource)
      ? value.restartRecoveryOperatorSource.sourceRunId
      : undefined,
    isRecord(value.restartRecoveryHarnessCompletion)
      ? value.restartRecoveryHarnessCompletion.sourceRunId
      : undefined,
  ].filter((id) => id !== undefined);
  const pending = normalizePendingFinalDelivery(value.pendingFinalDelivery);
  const pendingId = pending?.sourceRunId;
  const defer = (reason: string) => ({
    retire: false,
    warning: `Retained legacy restart custody: ${reason}. Next step: inspect this session's retained run/generation IDs and pending-delivery outcome against its transcript before repairing custody; custody was left intact.`,
  });
  if (
    [...runIds, ...custodyIds, pendingId].some(
      (id) => typeof id === "string" && hasAgentRunContextExecutionOwner(id),
    )
  ) {
    return defer("an execution owner is still live");
  }
  const unmatched = (reason: string) =>
    value.archivedAt !== undefined ||
    value.status === "done" ||
    value.status === "failed" ||
    value.status === "killed" ||
    value.status === "timeout"
      ? {
          retire: true,
          doctorOnly: true as const,
          warning: "Retired terminal unmatched legacy restart custody (original state backed up).",
        }
      : defer(reason);
  if (runs.some((run) => !ownsFence(run)) || custodyIds.some((id) => !ownsRun(id))) {
    return unmatched("a fence or delivery claim has no matching tombstone run/generation");
  }
  if (
    (pending ||
      value.pendingFinalDelivery === true ||
      normalizeOptionalString(value.pendingFinalDeliveryText)) &&
    !ownsRun(pendingId)
  ) {
    return unmatched("pending final delivery has no matching tombstone source run");
  }
  if (
    runIds.size === 0 &&
    generations.size === 0 &&
    Object.keys(value).some(
      (key) =>
        key.startsWith("restartRecovery") &&
        value[key] !== undefined &&
        (!Array.isArray(value[key]) || value[key].length > 0),
    )
  ) {
    return unmatched("no recorded generation links the retained custody to the tombstone");
  }
  return {
    retire: true,
    warning:
      "Recovered legacy restart tombstone; matching obsolete claims and pending delivery retired (original state backed up).",
  };
}

/** Retire file-era activity metadata without reconstructing an execution. */
export function migrateLegacySessionRunOutcome(
  value: Record<string, unknown>,
  updatedAt: unknown = value.updatedAt,
  options: { preserveTerminalRestartCustody?: boolean } = {},
): Record<string, unknown> {
  const tombstone = inspectLegacyRestartTombstone(value);
  if (
    tombstone &&
    (!tombstone.retire || (tombstone.doctorOnly && options.preserveTerminalRestartCustody))
  ) {
    return value;
  }
  if (tombstone?.retire) {
    const next = { ...value };
    // Tombstones predate the current admission owner. A continuation is not required.
    delete next.mainRestartRecovery;
    for (const key of Object.keys(next)) {
      if (key.startsWith("restartRecovery")) {
        delete next[key];
      }
    }
    if (!tombstone.doctorOnly) {
      delete next.activeWriterRunId;
      delete next.lifecycleRunId;
    }
    if (!tombstone.doctorOnly && next.archiveReason === "restart-recovery") {
      delete next.archivedAt;
      delete next.archivedBy;
      delete next.archiveReason;
    }
    // Replaying a final under retired sender authority can duplicate or misroute it.
    // The caller backs up the original row before retiring its delivery custody.
    const pending = normalizePendingFinalDelivery(next.pendingFinalDelivery);
    const deliveryUnknown =
      !pending?.deliveries?.length ||
      pending.deliveries.some(({ state }) => state !== "delivered" && state !== "suppressed");
    if ((pending || next.pendingFinalDelivery === true) && deliveryUnknown) {
      next.lastRunError =
        "Legacy restart recovery retired pending final delivery with an unknown outcome; the original is preserved in the pre-startup migration backup.";
      if (!tombstone.doctorOnly && pending?.context && !next.pendingDeliveryNotice) {
        next.pendingDeliveryNotice = {
          createdAt: pending.createdAt,
          context: pending.context,
          intentId: pending.intentId ?? `legacy-restart:${String(next.sessionId)}`,
          state: "owed",
        };
      }
    }
    delete next.pendingFinalDelivery;
    for (const key of LEGACY_SESSION_ENTRY_STATE_FIELDS) {
      if (key.startsWith("pendingFinalDelivery")) {
        delete next[key];
      }
    }
    // Terminal unmatched rows are historical cleanup, never a new execution or notice.
    if (tombstone.doctorOnly) {
      return next;
    }
    next.status = "interrupted";
    next.abortedLastRun = true;
    if (next.archivedAt === undefined && !next.modelSelectionLocked && !next.acp) {
      next.resumeAfterRestart ??= { queuedInputIds: [] };
    }
    return next;
  }
  if (value.status !== "running" && value.status !== "queued") {
    return value;
  }
  return {
    ...value,
    status: "killed",
    abortedLastRun: true,
    endedAt: asNonNegativeFiniteNumber(value.endedAt) ?? asNonNegativeFiniteNumber(updatedAt) ?? 0,
    activeWriterRunId: undefined,
    lifecycleRunId: undefined,
    lastRunError: undefined,
    suppressErrorNotice: true,
  };
}

/** Doctor preserves July routing and scalar-state contracts before removing their old keys. */
export function migrateLegacySessionEntryState(
  value: Record<string, unknown>,
  updatedAt: unknown = value.updatedAt,
  options: { preserveTerminalRestartCustody?: boolean } = {},
): SessionEntryStateRepair {
  const next = { ...value };
  const numericChanges: SessionEntryNumericSnapshot = {};
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
  for (const field of SESSION_ENTRY_NUMERIC_FIELDS) {
    const candidate = next[field];
    if (typeof candidate !== "string") {
      continue;
    }
    const number =
      field === "spawnDepth"
        ? parseStrictNonNegativeInteger(candidate)
        : parseStrictFiniteNumber(candidate);
    if (number !== undefined) {
      next[field] = number;
      numericChanges[field] = number;
    }
  }
  return {
    entry: migrateLegacySessionRunOutcome(next, updatedAt, options),
    numericChanges,
  };
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
  let next = admitCanonicalSessionEntry(
    migrateLegacySessionEntryState(value, value.updatedAt).entry,
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
