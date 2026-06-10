// Persists context-engine runtime quarantines so health surfaces can see
// failures recorded in sibling runtime processes.
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";

const CONTEXT_ENGINE_QUARANTINE_OWNER_ID = "core:context-engine-quarantine-health";
const CONTEXT_ENGINE_QUARANTINE_NAMESPACE = "runtime-quarantines";
const MAX_QUARANTINE_RECORDS = 64;

export type PersistedContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

type PersistedContextEngineQuarantineRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  recordedAtMs: number;
};

function openQuarantineStore() {
  return createCorePluginStateSyncKeyedStore<PersistedContextEngineQuarantineRecord>({
    ownerId: CONTEXT_ENGINE_QUARANTINE_OWNER_ID,
    namespace: CONTEXT_ENGINE_QUARANTINE_NAMESPACE,
    maxEntries: MAX_QUARANTINE_RECORDS,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRecord(value: unknown): PersistedContextEngineQuarantineRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<PersistedContextEngineQuarantineRecord>;
  if (
    !isNonEmptyString(record.engineId) ||
    !isNonEmptyString(record.operation) ||
    !isNonEmptyString(record.reason) ||
    typeof record.failedAtMs !== "number" ||
    !Number.isFinite(record.failedAtMs) ||
    typeof record.processId !== "number" ||
    !Number.isInteger(record.processId) ||
    record.processId <= 0 ||
    typeof record.recordedAtMs !== "number" ||
    !Number.isFinite(record.recordedAtMs)
  ) {
    return undefined;
  }
  return {
    engineId: record.engineId,
    operation: record.operation,
    reason: record.reason,
    failedAtMs: record.failedAtMs,
    processId: record.processId,
    recordedAtMs: record.recordedAtMs,
    ...(isNonEmptyString(record.owner) ? { owner: record.owner } : {}),
  };
}

function processLooksLive(processId: number): boolean {
  if (processId === process.pid) {
    return true;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function listPersistedRecords(): PersistedContextEngineQuarantineRecord[] {
  try {
    return openQuarantineStore()
      .entries()
      .map((entry) => normalizeRecord(entry.value))
      .filter((record): record is PersistedContextEngineQuarantineRecord => Boolean(record))
      .filter((record) => processLooksLive(record.processId));
  } catch {
    return [];
  }
}

function recordKey(record: Pick<PersistedContextEngineQuarantineRecord, "engineId" | "processId">) {
  return JSON.stringify([record.engineId, record.processId]);
}

export function recordPersistedContextEngineQuarantine(
  quarantine: PersistedContextEngineRuntimeQuarantine,
): void {
  const record: PersistedContextEngineQuarantineRecord = {
    engineId: quarantine.engineId,
    operation: quarantine.operation,
    reason: quarantine.reason,
    failedAtMs: quarantine.failedAt.getTime(),
    processId: process.pid,
    recordedAtMs: Date.now(),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  openQuarantineStore().registerIfAbsent(recordKey(record), record);
}

export function listPersistedContextEngineQuarantines(): PersistedContextEngineRuntimeQuarantine[] {
  const byEngineId = new Map<string, PersistedContextEngineQuarantineRecord>();
  for (const record of listPersistedRecords()) {
    const existing = byEngineId.get(record.engineId);
    if (!existing || record.failedAtMs < existing.failedAtMs) {
      byEngineId.set(record.engineId, record);
    }
  }
  return [...byEngineId.values()].map((record) => {
    const quarantine: PersistedContextEngineRuntimeQuarantine = {
      engineId: record.engineId,
      operation: record.operation,
      reason: record.reason,
      failedAt: new Date(record.failedAtMs),
    };
    if (record.owner) {
      quarantine.owner = record.owner;
    }
    return quarantine;
  });
}

export function clearPersistedContextEngineQuarantineForProcess(
  engineId: string | undefined,
  processId: number,
): void {
  try {
    const store = openQuarantineStore();
    for (const entry of store.entries()) {
      const record = normalizeRecord(entry.value);
      if (
        record?.processId === processId &&
        (engineId === undefined || record.engineId === engineId)
      ) {
        store.delete(entry.key);
      }
    }
  } catch {
    // Best-effort cleanup; callers still clear in-memory state.
  }
}
