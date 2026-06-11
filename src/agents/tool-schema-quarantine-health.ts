// Persists runtime tool-schema quarantines in the shared SQLite-backed core
// plugin-state store so health surfaces can see failures from any live
// runtime process.
import {
  createRuntimeHealthStore,
  type RuntimeHealthRecordEnvelope,
} from "../plugin-state/runtime-health-store.js";

export type RuntimeToolSchemaQuarantine = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAt: Date;
};

type PersistedRuntimeToolSchemaQuarantineRecord = RuntimeHealthRecordEnvelope & {
  toolName: string;
  owner?: string;
  reason: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const quarantineStore = createRuntimeHealthStore<PersistedRuntimeToolSchemaQuarantineRecord>({
  ownerId: "core:runtime-tool-quarantine-health",
  namespace: "schema-quarantines",
  maxEntries: 128,
  // Failing runs re-register their quarantine and refresh this TTL, so it only
  // expires records that stop recurring (e.g. a schema fixed without restart).
  ttlMs: 24 * 60 * 60 * 1_000,
  normalizeRecord: (value) => {
    if (!isNonEmptyString(value.toolName) || !isNonEmptyString(value.reason)) {
      return undefined;
    }
    return {
      toolName: value.toolName,
      reason: value.reason,
      failedAtMs: value.failedAtMs,
      processId: value.processId,
      ...(isNonEmptyString(value.owner) ? { owner: value.owner } : {}),
    };
  },
  displayKey: (record) => JSON.stringify([record.owner ?? "", record.toolName]),
  // Latest wins: the most recent violation message is the actionable one.
  pick: "latest",
});

function recordKey(
  record: Pick<PersistedRuntimeToolSchemaQuarantineRecord, "owner" | "toolName" | "processId">,
): string {
  return JSON.stringify([record.owner ?? "", record.toolName, record.processId]);
}

export function recordPersistedRuntimeToolSchemaQuarantine(
  quarantine: RuntimeToolSchemaQuarantine,
): void {
  const record: PersistedRuntimeToolSchemaQuarantineRecord = {
    toolName: quarantine.toolName,
    reason: quarantine.reason,
    failedAtMs: quarantine.failedAt.getTime(),
    processId: process.pid,
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  quarantineStore.register(recordKey(record), record);
}

export function listPersistedRuntimeToolSchemaQuarantines(): RuntimeToolSchemaQuarantine[] {
  return quarantineStore.list().map((record) => {
    const quarantine: RuntimeToolSchemaQuarantine = {
      toolName: record.toolName,
      reason: record.reason,
      failedAt: new Date(record.failedAtMs),
    };
    if (record.owner) {
      quarantine.owner = record.owner;
    }
    return quarantine;
  });
}
