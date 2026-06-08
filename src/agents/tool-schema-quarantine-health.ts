// Persists runtime tool-schema quarantines in the shared SQLite-backed core
// plugin-state store so sibling runtime processes can surface health failures.
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";

const TOOL_SCHEMA_QUARANTINE_OWNER_ID = "core:runtime-tool-quarantine-health";
const TOOL_SCHEMA_QUARANTINE_NAMESPACE = "schema-quarantines";
const MAX_TOOL_SCHEMA_QUARANTINE_RECORDS = 128;
const DEFAULT_TOOL_SCHEMA_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1_000;

export type RuntimeToolSchemaQuarantine = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAt: Date;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type PersistedRuntimeToolSchemaQuarantineRecord = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  recordedAtMs: number;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
};

function openQuarantineStore() {
  return createCorePluginStateSyncKeyedStore<PersistedRuntimeToolSchemaQuarantineRecord>({
    ownerId: TOOL_SCHEMA_QUARANTINE_OWNER_ID,
    namespace: TOOL_SCHEMA_QUARANTINE_NAMESPACE,
    maxEntries: MAX_TOOL_SCHEMA_QUARANTINE_RECORDS,
    defaultTtlMs: DEFAULT_TOOL_SCHEMA_QUARANTINE_TTL_MS,
  });
}

function recordKey(
  record: Pick<PersistedRuntimeToolSchemaQuarantineRecord, "owner" | "toolName" | "processId">,
): string {
  return JSON.stringify([record.owner ?? "", record.toolName, record.processId]);
}

function isPersistedRecord(value: unknown): value is PersistedRuntimeToolSchemaQuarantineRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<PersistedRuntimeToolSchemaQuarantineRecord>;
  return (
    typeof record.toolName === "string" &&
    record.toolName.trim().length > 0 &&
    typeof record.reason === "string" &&
    record.reason.trim().length > 0 &&
    typeof record.failedAtMs === "number" &&
    Number.isFinite(record.failedAtMs) &&
    typeof record.processId === "number" &&
    Number.isInteger(record.processId) &&
    record.processId > 0 &&
    typeof record.recordedAtMs === "number" &&
    Number.isFinite(record.recordedAtMs)
  );
}

function normalizeRecord(value: unknown): PersistedRuntimeToolSchemaQuarantineRecord | undefined {
  if (!isPersistedRecord(value)) {
    return undefined;
  }
  return {
    toolName: value.toolName,
    reason: value.reason,
    failedAtMs: value.failedAtMs,
    processId: value.processId,
    recordedAtMs: value.recordedAtMs,
    ...(typeof value.owner === "string" && value.owner.trim() ? { owner: value.owner } : {}),
    ...(typeof value.runId === "string" && value.runId.trim() ? { runId: value.runId } : {}),
    ...(typeof value.sessionKey === "string" && value.sessionKey.trim()
      ? { sessionKey: value.sessionKey }
      : {}),
    ...(typeof value.sessionId === "string" && value.sessionId.trim()
      ? { sessionId: value.sessionId }
      : {}),
  };
}

function listPersistedRecords(): PersistedRuntimeToolSchemaQuarantineRecord[] {
  try {
    return openQuarantineStore()
      .entries()
      .map((entry) => normalizeRecord(entry.value))
      .filter((record): record is PersistedRuntimeToolSchemaQuarantineRecord => Boolean(record));
  } catch {
    return [];
  }
}

export function recordPersistedRuntimeToolSchemaQuarantine(
  quarantine: RuntimeToolSchemaQuarantine,
): void {
  const record: PersistedRuntimeToolSchemaQuarantineRecord = {
    toolName: quarantine.toolName,
    reason: quarantine.reason,
    failedAtMs: quarantine.failedAt.getTime(),
    processId: process.pid,
    recordedAtMs: Date.now(),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
    ...(quarantine.runId ? { runId: quarantine.runId } : {}),
    ...(quarantine.sessionKey ? { sessionKey: quarantine.sessionKey } : {}),
    ...(quarantine.sessionId ? { sessionId: quarantine.sessionId } : {}),
  };
  openQuarantineStore().register(recordKey(record), record);
}

export function listPersistedRuntimeToolSchemaQuarantines(): RuntimeToolSchemaQuarantine[] {
  const byTool = new Map<string, PersistedRuntimeToolSchemaQuarantineRecord>();
  for (const record of listPersistedRecords()) {
    const key = `${record.owner ?? ""}\0${record.toolName}`;
    const existing = byTool.get(key);
    if (!existing || record.failedAtMs > existing.failedAtMs) {
      byTool.set(key, record);
    }
  }
  return [...byTool.values()].map((record) => {
    const quarantine: RuntimeToolSchemaQuarantine = {
      toolName: record.toolName,
      reason: record.reason,
      failedAt: new Date(record.failedAtMs),
    };
    if (record.owner) {
      quarantine.owner = record.owner;
    }
    if (record.runId) {
      quarantine.runId = record.runId;
    }
    if (record.sessionKey) {
      quarantine.sessionKey = record.sessionKey;
    }
    if (record.sessionId) {
      quarantine.sessionId = record.sessionId;
    }
    return quarantine;
  });
}

export function clearPersistedRuntimeToolSchemaQuarantinesForProcess(
  processId = process.pid,
): void {
  try {
    const store = openQuarantineStore();
    for (const entry of store.entries()) {
      const record = normalizeRecord(entry.value);
      if (record?.processId === processId) {
        store.delete(entry.key);
      }
    }
  } catch {
    // Best-effort cleanup for tests and process lifecycle.
  }
}
