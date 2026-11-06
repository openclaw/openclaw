// Persists runtime tool-schema quarantines in the shared SQLite-backed core
// plugin-state store so health surfaces can see failures from any live
// runtime process.
import {
  normalizeToolSchemaQuarantineRecord,
  runtimeToolSchemaIdentityKey,
  type ToolSchemaQuarantineRecord,
} from "../plugin-state/runtime-health-records.js";
import {
  createRuntimeHealthRecordEnvelope,
  createRuntimeHealthStore,
} from "../plugin-state/runtime-health-store.js";

type RuntimeToolSchemaQuarantine = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAt: Date;
};

const quarantineStore = createRuntimeHealthStore<ToolSchemaQuarantineRecord>({
  ownerId: "core:runtime-tool-quarantine-health",
  namespace: "schema-quarantines",
  maxEntries: 128,
  // Failing runs re-register their quarantine and refresh this TTL, so it only
  // expires records that stop recurring (e.g. a schema fixed without restart).
  ttlMs: 24 * 60 * 60 * 1_000,
  normalizeRecord: normalizeToolSchemaQuarantineRecord,
  displayKey: (record) => JSON.stringify([record.owner ?? "", record.toolName]),
  // Latest wins: the most recent violation message is the actionable one.
  pick: "latest",
});

function recordKey(
  record: Pick<ToolSchemaQuarantineRecord, "owner" | "toolName" | "processId">,
): string {
  return JSON.stringify([record.owner ?? "", record.toolName, record.processId]);
}

export type RuntimeToolSchemaQuarantineIdentity = {
  toolName: string;
  owner?: string;
};

// Remember submitted records before awaiting them, so recovery also joins a pending write.
const submittedQuarantines = new Set<string>();

export async function recordPersistedRuntimeToolSchemaQuarantine(
  quarantine: RuntimeToolSchemaQuarantine,
): Promise<void> {
  const record: ToolSchemaQuarantineRecord = {
    toolName: quarantine.toolName,
    reason: quarantine.reason,
    ...createRuntimeHealthRecordEnvelope(quarantine.failedAt),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  submittedQuarantines.add(runtimeToolSchemaIdentityKey(record));
  await quarantineStore.register(recordKey(record), record);
}

/**
 * Removes this process's persisted quarantines for tools that now validate
 * cleanly. `listHealthyTools` is only invoked when this process has persisted
 * quarantines, keeping the common per-run path free of work.
 */
export async function clearRecoveredPersistedRuntimeToolSchemaQuarantines(
  listHealthyTools: () => readonly RuntimeToolSchemaQuarantineIdentity[],
): Promise<void> {
  if (submittedQuarantines.size === 0) {
    return;
  }
  const recoveredKeys = listHealthyTools()
    .map(runtimeToolSchemaIdentityKey)
    .filter((key) => submittedQuarantines.has(key));
  if (recoveredKeys.length === 0) {
    return;
  }
  // The worker orders this diagnostic cleanup before later registrations.
  const cleared = await quarantineStore.clearForProcess(process.pid, {
    kind: "tool-schema",
    keys: recoveredKeys,
  });
  if (cleared) {
    for (const key of recoveredKeys) {
      submittedQuarantines.delete(key);
    }
  }
}

export async function listPersistedRuntimeToolSchemaQuarantines(): Promise<
  RuntimeToolSchemaQuarantine[]
> {
  return (await quarantineStore.list()).map((record) => {
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
