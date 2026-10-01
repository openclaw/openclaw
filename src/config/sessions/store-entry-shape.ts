import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import { hasLegacySessionEntryState } from "./session-entry-state-format.js";
import type { PendingTranscriptRepairState, SessionEntry } from "./types.js";

function normalizeSessionEntryArchiveReason(
  value: unknown,
): SessionEntry["archiveReason"] | undefined {
  return value === "manual" ||
    value === "active-session-cap" ||
    value === "age-retention" ||
    value === "stale-dashboard" ||
    value === "restart-recovery"
    ? value
    : undefined;
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : (asNonNegativeFiniteNumber(value) ?? 0);
}

/** Removes retired runtime locator fields before a session entry is persisted or returned. */
export function projectCanonicalSessionEntryShape(value: Record<string, unknown>): SessionEntry {
  if (hasLegacySessionEntryState(value)) {
    throw new SessionStoreMigrationRequiredError(
      "Legacy session entry state requires migration; stop the Gateway and run openclaw doctor --fix.",
    );
  }
  const {
    sessionFile: _retiredSessionFile,
    transcriptPath: _retiredTranscriptPath,
    owner: _projectedOwner,
    participants: _projectedParticipants,
    participantCount: _projectedParticipantCount,
    ...canonicalValue
  } = value;
  const setOptionalField = (key: keyof SessionEntry, normalized: unknown) => {
    if (normalized) {
      canonicalValue[key] = normalized;
    } else {
      delete canonicalValue[key];
    }
  };
  const icon =
    typeof canonicalValue.icon === "string" ? normalizeSessionIconValue(canonicalValue.icon) : null;
  setOptionalField("icon", icon);
  const color =
    typeof canonicalValue.color === "string"
      ? normalizeSessionColorValue(canonicalValue.color)
      : null;
  setOptionalField("color", color);
  setOptionalField(
    "pendingFinalDelivery",
    normalizePendingFinalDelivery(canonicalValue.pendingFinalDelivery),
  );
  setOptionalField(
    "pendingDeliveryNotice",
    normalizePendingDeliveryNotice(canonicalValue.pendingDeliveryNotice),
  );
  setOptionalField(
    "pendingTranscriptRepair",
    normalizePendingTranscriptRepair(canonicalValue.pendingTranscriptRepair),
  );
  setOptionalField("fallbackNotice", normalizeFallbackNotice(canonicalValue.fallbackNotice));
  setOptionalField("memoryFlush", normalizeMemoryFlush(canonicalValue.memoryFlush));
  const archiveReason = normalizeSessionEntryArchiveReason(canonicalValue.archiveReason);
  if (canonicalValue.archivedAt !== undefined) {
    setOptionalField("archiveReason", archiveReason);
  } else {
    delete canonicalValue.archivedBy;
    delete canonicalValue.archiveReason;
  }
  // An archived entry never carries a snooze: automatic archival (cap, age,
  // stale-dashboard) writes archive facts without the patch path, and a later
  // restore must not resurface a still-hidden session.
  if (
    canonicalValue.archivedAt !== undefined ||
    typeof canonicalValue.snoozedUntil !== "number" ||
    !Number.isFinite(canonicalValue.snoozedUntil) ||
    canonicalValue.snoozedUntil <= 0
  ) {
    delete canonicalValue.snoozedUntil;
    delete canonicalValue.snoozedAt;
  }
  return canonicalValue as unknown as SessionEntry;
}

/** Removes the runtime-only skill catalog without mutating the live session snapshot. */
export function stripRuntimeOnlySessionSkillsFields(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (snapshot?.resolvedSkills === undefined && snapshot?.discoverySkills === undefined) {
    return entry;
  }
  const {
    resolvedSkills: _dropResolved,
    discoverySkills: _dropDiscovery,
    ...skillsSnapshot
  } = snapshot;
  return { ...entry, skillsSnapshot };
}

export function normalizePendingFinalDelivery(
  value: unknown,
): SessionEntry["pendingFinalDelivery"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (createdAt === undefined) {
    return undefined;
  }
  const intentId = normalizeOptionalString(value.intentId);
  const deliveries = normalizePendingFinalDeliveries(value.deliveries);
  const base = {
    createdAt,
    ...(isRecord(value.context) ? { context: value.context } : {}),
    ...(intentId ? { intentId } : {}),
    ...(deliveries ? { deliveries } : {}),
  };
  if (value.kind === "transport-only") {
    return { kind: "transport-only", ...base };
  }
  const text = normalizeOptionalString(value.text);
  return value.kind === "replayable" && text ? { kind: "replayable", text, ...base } : undefined;
}

function normalizePendingFinalDeliveries(
  value: unknown,
): NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deliveries: NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]> =
    value.flatMap((item) => {
      const id = isRecord(item) ? normalizeOptionalString(item.id) : undefined;
      const state = isRecord(item) ? item.state : undefined;
      return id &&
        (state === "prepared" ||
          state === "queued" ||
          state === "delivered" ||
          state === "suppressed" ||
          state === "unknown")
        ? [{ id, state }]
        : [];
    });
  return deliveries.length > 0 ? deliveries : undefined;
}

function normalizePendingDeliveryNotice(
  value: unknown,
): SessionEntry["pendingDeliveryNotice"] | undefined {
  if (!isRecord(value) || !isRecord(value.context)) {
    return undefined;
  }
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  const intentId = normalizeOptionalString(value.intentId);
  return createdAt !== undefined &&
    intentId &&
    (value.state === "owed" || value.state === "unresolved" || value.state === "acknowledged")
    ? { createdAt, context: value.context, intentId, state: value.state }
    : undefined;
}

function normalizePendingTranscriptRepair(
  value: unknown,
): SessionEntry["pendingTranscriptRepair"] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const normalized: NonNullable<SessionEntry["pendingTranscriptRepair"]> = [];
  for (const item of value) {
    const record = normalizePendingTranscriptRepairRecord(item);
    if (record) {
      normalized.push(record);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePendingTranscriptRepairRecord(
  value: unknown,
): PendingTranscriptRepairState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id);
  const text = normalizeOptionalString(value.text);
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (!id || !text || createdAt === undefined) {
    return undefined;
  }
  const provider = normalizeOptionalString(value.provider);
  const model = normalizeOptionalString(value.model);
  return {
    id,
    text,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    createdAt,
  };
}

export function normalizeFallbackNotice(
  value: unknown,
): SessionEntry["fallbackNotice"] | undefined {
  if (!isRecord(value) || value.kind !== "active") {
    return undefined;
  }
  const selectedModel = normalizeOptionalString(value.selectedModel);
  const activeModel = normalizeOptionalString(value.activeModel);
  const reason = normalizeOptionalString(value.reason);
  return selectedModel && activeModel
    ? { kind: "active", selectedModel, activeModel, ...(reason ? { reason } : {}) }
    : undefined;
}

export function normalizeMemoryFlush(value: unknown): SessionEntry["memoryFlush"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compactionCount = normalizeCount(value.compactionCount);
  if (value.kind === "succeeded" && compactionCount !== undefined) {
    return { kind: "succeeded", compactionCount };
  }
  const failureCount = normalizeCount(value.failureCount);
  if (value.kind !== "failed" || !failureCount) {
    return undefined;
  }
  return {
    kind: "failed",
    ...(compactionCount !== undefined ? { compactionCount } : {}),
    failureCount,
  };
}

function normalizeCount(value: unknown): number | undefined {
  const number = asNonNegativeFiniteNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}
