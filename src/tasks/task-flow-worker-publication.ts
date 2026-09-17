import { createDeferredCore } from "../shared/deferred.js";
import {
  areTaskFlowRecordsEqual,
  cloneFlowRecord,
  normalizeRestoredFlowRecord,
} from "./task-flow-registry.records.js";
import type { FlowRegistryPublication } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type PendingTaskFlowPublication = {
  lastPublished: TaskFlowRecord | undefined;
  readTail?: Promise<void>;
  readers: Set<{ written: boolean }>;
};

/** A witnessed committed projection write supersedes a held read, including absent ABA. */
export async function reconcileTaskFlowWorkerPublication(params: {
  flowId: string;
  pending: PendingTaskFlowPublication;
  assertCurrent: () => void;
  current: () => TaskFlowRecord | undefined;
  read: () => Promise<TaskFlowRecord | undefined>;
  install: (flow: TaskFlowRecord | undefined) => void;
  emit: (event: () => FlowRegistryPublication) => void;
}): Promise<boolean> {
  const { flowId, pending, assertCurrent, current, read, install, emit } = params;
  const predecessor = pending.readTail;
  const phase = createDeferredCore();
  pending.readTail = phase.promise;
  const witness = { written: false };
  let next: TaskFlowRecord | undefined;
  let conflicted = false;
  try {
    await predecessor;
    assertCurrent();
    pending.readers.add(witness);
    const before = current();
    const captured = before && cloneFlowRecord(before);
    const record = await read();
    pending.readers.delete(witness);
    assertCurrent();
    const cached = current();
    conflicted = witness.written || !areTaskFlowRecordsEqual(captured, cached);
    next = conflicted ? cached : record ? normalizeRestoredFlowRecord(record) : undefined;
    if (!areTaskFlowRecordsEqual(cached, next)) {
      install(next);
    }
  } finally {
    pending.readers.delete(witness);
    if (pending.readTail === phase.promise) {
      delete pending.readTail;
    }
    phase.resolve();
  }
  const previous = pending.lastPublished;
  if (!areTaskFlowRecordsEqual(previous, next)) {
    if (next) {
      emit(() => ({ kind: "upserted", flow: next, ...(previous ? { previous } : {}) }));
    } else if (previous) {
      emit(() => ({ kind: "deleted", flowId, previous }));
    }
  }
  return !conflicted;
}
