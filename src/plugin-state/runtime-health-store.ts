// Shared mechanics for cross-process runtime health records persisted in the
// core plugin-state store: envelope validation, process-liveness hygiene, and
// per-process cleanup. Domain modules own record fields and display keys.
import { createCorePluginStateSyncKeyedStore } from "./plugin-state-store.js";

/** Envelope persisted with every cross-process runtime health record. */
export type RuntimeHealthRecordEnvelope = {
  processId: number;
  failedAtMs: number;
};

export type RuntimeHealthStoreOptions<T extends RuntimeHealthRecordEnvelope> = {
  ownerId: `core:${string}`;
  namespace: string;
  maxEntries: number;
  /** Optional expiry backstop on top of liveness filtering. */
  ttlMs?: number;
  /** Validates domain fields and strips unknown ones; envelope is pre-validated. */
  normalizeRecord: (value: Record<string, unknown> & RuntimeHealthRecordEnvelope) => T | undefined;
  /** Groups records for display dedupe across recorder processes. */
  displayKey: (record: T) => string;
  /** Which failedAtMs wins per display group: root cause vs most recent reason. */
  pick: "earliest" | "latest";
};

export type RuntimeHealthStore<T extends RuntimeHealthRecordEnvelope> = {
  /** Persists a record under the key, overwriting any prior value. */
  register(key: string, record: T): void;
  /** One record per display group, restricted to live recorder processes. */
  list(): T[];
  /** Removes records recorded by the process, optionally narrowed by predicate. */
  clearForProcess(processId: number, matches?: (record: T) => boolean): void;
};

function hasValidEnvelope(
  value: unknown,
): value is Record<string, unknown> & RuntimeHealthRecordEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<RuntimeHealthRecordEnvelope>;
  return (
    typeof record.processId === "number" &&
    Number.isInteger(record.processId) &&
    record.processId > 0 &&
    typeof record.failedAtMs === "number" &&
    Number.isFinite(record.failedAtMs)
  );
}

// Liveness keeps health output actionable across restarts: a dead recorder's
// failures disappear instead of lingering as stale state. PID reuse can keep a
// stale record alive briefly; per-store TTLs bound that window.
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

/** Opens a SQLite-backed health record namespace shared across runtime processes. */
export function createRuntimeHealthStore<T extends RuntimeHealthRecordEnvelope>(
  options: RuntimeHealthStoreOptions<T>,
): RuntimeHealthStore<T> {
  // The keyed store is opened per operation so records follow the state dir
  // active at call time (tests and embedded runtimes swap OPENCLAW_STATE_DIR).
  const openStore = () =>
    createCorePluginStateSyncKeyedStore<T>({
      ownerId: options.ownerId,
      namespace: options.namespace,
      maxEntries: options.maxEntries,
      ...(options.ttlMs != null ? { defaultTtlMs: options.ttlMs } : {}),
    });

  const normalize = (value: unknown): T | undefined =>
    hasValidEnvelope(value) ? options.normalizeRecord(value) : undefined;

  return {
    register(key, record) {
      openStore().register(key, record);
    },
    list() {
      try {
        const byGroup = new Map<string, T>();
        for (const entry of openStore().entries()) {
          const record = normalize(entry.value);
          if (!record || !processLooksLive(record.processId)) {
            continue;
          }
          const groupKey = options.displayKey(record);
          const existing = byGroup.get(groupKey);
          const wins =
            !existing ||
            (options.pick === "latest"
              ? record.failedAtMs > existing.failedAtMs
              : record.failedAtMs < existing.failedAtMs);
          if (wins) {
            byGroup.set(groupKey, record);
          }
        }
        return [...byGroup.values()];
      } catch {
        return [];
      }
    },
    clearForProcess(processId, matches) {
      try {
        const store = openStore();
        for (const entry of store.entries()) {
          const record = normalize(entry.value);
          if (record?.processId === processId && (!matches || matches(record))) {
            store.delete(entry.key);
          }
        }
      } catch {
        // Best-effort cleanup; callers also clear their in-memory state.
      }
    },
  };
}
