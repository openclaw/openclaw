import { createDeferredCore } from "../shared/deferred.js";
import {
  areTaskFlowRecordsEqual,
  cloneFlowRecord,
  normalizeRestoredFlowRecord,
} from "./task-flow-registry.records.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type PendingTaskFlowPublication = {
  readTail?: Promise<void>;
  readers: Set<{ written: boolean }>;
};

/** A witnessed committed projection write supersedes a held read, including absent ABA. */
export async function reconcileTaskFlowWorkerPublication(params: {
  pending: PendingTaskFlowPublication;
  assertCurrent: () => void;
  current: () => TaskFlowRecord | undefined;
  read: () => Promise<TaskFlowRecord | undefined>;
  install: (flow: TaskFlowRecord | undefined) => void;
}): Promise<boolean> {
  const { pending, assertCurrent, current, read, install } = params;
  const predecessor = pending.readTail;
  const phase = createDeferredCore();
  pending.readTail = phase.promise;
  const witness = { written: false };
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
    const next = conflicted ? cached : record ? normalizeRestoredFlowRecord(record) : undefined;
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
  return !conflicted;
}
