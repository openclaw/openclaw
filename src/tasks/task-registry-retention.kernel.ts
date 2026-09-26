import type { DatabaseSync } from "node:sqlite";
import { captureTaskRetentionSource } from "./task-registry-retention-source.js";
import {
  prepareTaskRetention,
  type TaskRetentionInput,
  type TaskRetentionResult,
} from "./task-registry-retention.operation.js";
import {
  bindTaskRecord,
  deleteTaskRowsWithDeliveryState,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";

/** The caller retains one transaction through current-row selection and its mutation. */
export function applyTaskRetentionInDatabase(
  db: DatabaseSync,
  input: TaskRetentionInput,
  assertCurrent: () => void,
): TaskRetentionResult {
  const current = readTaskRecord(db, input.taskId);
  if (!current || captureTaskRetentionSource(current).version !== input.sourceVersion) {
    return { kind: "unchanged" };
  }
  const result = prepareTaskRetention(current, input);
  if (result.kind === "unchanged") {
    return result;
  }
  assertCurrent();
  if (result.kind === "pruned") {
    deleteTaskRowsWithDeliveryState(db, input.taskId);
  } else {
    // A cleanup deadline does not replace the task's delivery state.
    upsertTaskRunRowInDatabase({ db }, bindTaskRecord(result.task));
  }
  return result;
}
