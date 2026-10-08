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
// Identity checks below keep a late clear reply from forgetting a newer same-key failure.
const submittedQuarantines = new Map<string, symbol>();

export async function recordPersistedRuntimeToolSchemaQuarantine(
  quarantine: RuntimeToolSchemaQuarantine,
): Promise<void> {
  const record: ToolSchemaQuarantineRecord = {
    toolName: quarantine.toolName,
    reason: quarantine.reason,
    ...createRuntimeHealthRecordEnvelope(quarantine.failedAt),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  submittedQuarantines.set(
    runtimeToolSchemaIdentityKey(record),
    Symbol("runtime-tool-quarantine-submission"),
  );
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
  const recoveredKeys = new Map(
    listHealthyTools()
      .map(runtimeToolSchemaIdentityKey)
      .flatMap((key) => {
        const submission = submittedQuarantines.get(key);
        return submission ? [[key, submission] as const] : [];
      }),
  );
  if (recoveredKeys.size === 0) {
    return;
  }
  // Capture every key's source now; a renewed failure must not veto another key's recovery.
  await Promise.all(
    Array.from(recoveredKeys, async ([key, submission]) => {
      const cleared = await quarantineStore.clearForProcess(
        process.pid,
        { kind: "tool-schema", keys: [key] },
        () => {
          if (submittedQuarantines.get(key) !== submission) {
            throw new Error("Runtime tool quarantine changed during recovery");
          }
        },
      );
      if (cleared && submittedQuarantines.get(key) === submission) {
        submittedQuarantines.delete(key);
      }
    }),
  );
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
