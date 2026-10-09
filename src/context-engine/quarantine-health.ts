// Persists context-engine runtime quarantines so health surfaces can see
// failures recorded in sibling runtime processes.
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  normalizeContextEngineQuarantineRecord,
  selectRuntimeHealthClearKeys,
  type ContextEngineQuarantineRecord,
} from "../plugin-state/runtime-health-records.js";
import {
  createRuntimeHealthRecordEnvelope,
  createRuntimeHealthStore,
} from "../plugin-state/runtime-health-store.js";

type PersistedContextEngineRuntimeQuarantine = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date;
};

const storeOptions = {
  ownerId: "core:context-engine-quarantine-health" as const,
  namespace: "runtime-quarantines",
  maxEntries: 64,
};

// No TTL: a quarantine is recorded once per failure and stays valid for the
// recorder's lifetime, so process liveness alone owns expiry here.
const quarantineStore = createRuntimeHealthStore<ContextEngineQuarantineRecord>({
  ...storeOptions,
  normalizeRecord: normalizeContextEngineQuarantineRecord,
  displayKey: (record) => record.engineId,
  // Earliest wins, matching the in-memory registry's first-failure-wins rule
  // so health output points at the root cause, not follow-on failures.
  pick: "earliest",
});

export async function recordPersistedContextEngineQuarantine(
  quarantine: PersistedContextEngineRuntimeQuarantine,
  assertCurrent?: () => void,
): Promise<void> {
  const record: ContextEngineQuarantineRecord = {
    engineId: quarantine.engineId,
    operation: quarantine.operation,
    reason: quarantine.reason,
    ...createRuntimeHealthRecordEnvelope(quarantine.failedAt),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  };
  // The in-memory registry only records the first quarantine per engine, so
  // this is called at most once per (engine, process) and overwrite is safe.
  await quarantineStore.register(
    JSON.stringify([record.engineId, record.processId]),
    record,
    assertCurrent,
  );
}

export async function listPersistedContextEngineQuarantines(): Promise<
  PersistedContextEngineRuntimeQuarantine[]
> {
  return (await quarantineStore.list()).map(
    ({ engineId, operation, reason, owner, failedAtMs }) => {
      const quarantine: PersistedContextEngineRuntimeQuarantine = {
        engineId,
        operation,
        reason,
        failedAt: new Date(failedAtMs),
      };
      if (owner) {
        quarantine.owner = owner;
      }
      return quarantine;
    },
  );
}

export async function clearPersistedContextEngineQuarantineForProcess(
  engineId: string | undefined,
  processId: number,
  assertCurrent?: () => void,
): Promise<void> {
  await quarantineStore.clearForProcess(
    processId,
    { kind: "context-engine", engineId },
    assertCurrent,
  );
}

/** Activation keeps its existing synchronous publication and rollback frame. */
export function clearPersistedContextEngineQuarantineForActivation(engineId: string): void {
  try {
    const store = createCorePluginStateSyncKeyedStore<ContextEngineQuarantineRecord>(storeOptions);
    for (const key of selectRuntimeHealthClearKeys(store.entries(), process.pid, {
      kind: "context-engine",
      engineId,
    })) {
      store.delete(key);
    }
  } catch {
    // Activation already cleared its authoritative in-memory quarantine.
  }
}
