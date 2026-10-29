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
import { parseAgentSessionKey } from "../../../routing/session-key.js";

export type SessionEntryStateRepair = {
  entry: Record<string, unknown>;
  numericChanges?: SessionEntryNumericSnapshot;
};

/** Retire file-era activity metadata without reconstructing an execution. */
export function migrateLegacySessionRunOutcome(
  value: Record<string, unknown>,
  updatedAt: unknown = value.updatedAt,
): Record<string, unknown> {
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
    entry: migrateLegacySessionRunOutcome(next, updatedAt),
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
