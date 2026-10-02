// Shared mechanics for cross-process runtime health records persisted in the
// core plugin-state store: envelope validation, process-liveness hygiene, and
// per-process cleanup. Domain modules own record fields and display keys.
import { randomUUID } from "node:crypto";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { createCorePluginStateKeyedStore } from "./plugin-state-store.js";
import { clearRuntimeHealthInWorker } from "./plugin-state-worker-client.js";
import {
  hasValidRuntimeHealthEnvelope,
  type RuntimeHealthClearSelection,
  type RuntimeHealthRecordEnvelope,
} from "./runtime-health-records.js";

// One token per process lifetime: a restarted process (even with a recycled
// PID) can never match records written by its predecessor.
const currentProcessToken = randomUUID();

type RuntimeHealthStoreOptions<T extends RuntimeHealthRecordEnvelope> = {
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

type RuntimeHealthStore<T extends RuntimeHealthRecordEnvelope> = {
  /** Persists a record under the key, overwriting any prior value. */
  register(key: string, record: T, assertCurrent?: () => void): Promise<void>;
  /** One record per display group, restricted to live recorder processes. */
  list(): Promise<T[]>;
  /** Removes records recorded by the process and selected by its health owner. */
  clearForProcess(
    processId: number,
    selection: RuntimeHealthClearSelection,
    assertCurrent?: () => void,
  ): Promise<boolean>;
};

/** Builds the common health envelope for records owned by this process. */
export function createRuntimeHealthRecordEnvelope(failedAt: Date): RuntimeHealthRecordEnvelope {
  return {
    processId: process.pid,
    processToken: currentProcessToken,
    processStartTime: getProcessStartTime(process.pid),
    failedAtMs: failedAt.getTime(),
  };
}

// Records surface only with a positive incarnation match; unverifiable
// identity fails closed so a recycled PID can never keep stale failures alive.
// Own PID: the per-process token proves incarnation on every platform.
// Sibling PIDs: the Linux /proc starttime must match; where it is unavailable
// (non-Linux, /proc read failure) sibling visibility is sacrificed instead of
// trusting a bare kill(0) liveness probe.
function processLooksLive(record: RuntimeHealthRecordEnvelope): boolean {
  if (record.processId === process.pid) {
    return record.processToken === currentProcessToken;
  }
  const currentStartTime = getProcessStartTime(record.processId);
  return currentStartTime !== null && currentStartTime === record.processStartTime;
}

/** Opens a SQLite-backed health record namespace shared across runtime processes. */
export function createRuntimeHealthStore<T extends RuntimeHealthRecordEnvelope>(
  options: RuntimeHealthStoreOptions<T>,
): RuntimeHealthStore<T> {
  // The keyed store is opened per operation so records follow the state dir
  // active at call time (tests and embedded runtimes swap OPENCLAW_STATE_DIR).
  const storeOptions = () => ({
    ownerId: options.ownerId,
    namespace: options.namespace,
    maxEntries: options.maxEntries,
    ...(options.ttlMs != null ? { defaultTtlMs: options.ttlMs } : {}),
  });

  const normalize = (value: unknown): T | undefined =>
    hasValidRuntimeHealthEnvelope(value) ? options.normalizeRecord(value) : undefined;

  return {
    async register(key, record, assertCurrent) {
      await createCorePluginStateKeyedStore<T>(storeOptions()).register(key, record, {
        assertCurrent,
      });
    },
    async list() {
      try {
        const byGroup = new Map<string, T>();
        for (const entry of await createCorePluginStateKeyedStore<T>(storeOptions()).entries()) {
          const record = normalize(entry.value);
          if (!record || !processLooksLive(record)) {
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
    async clearForProcess(processId, selection, assertCurrent) {
      try {
        await clearRuntimeHealthInWorker({
          pluginId: options.ownerId,
          namespace: options.namespace,
          processId,
          selection:
            selection.kind === "tool-schema"
              ? { ...selection, keys: [...selection.keys] }
              : { ...selection },
          assertCurrent,
        });
        return true;
      } catch {
        // Best-effort cleanup; callers also clear their in-memory state.
        return false;
      }
    },
  };
}
