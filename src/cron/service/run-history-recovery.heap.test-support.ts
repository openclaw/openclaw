import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { findCronRunRecoveryInDatabase } from "./run-history-recovery.js";

// Recovers one run from a private state database inside a heap-limited worker.
serveWorkerTasks((input) => {
  assert.ok(isRecord(input));
  const { path, jobId, startedAt, storeKey, receiptId } = input;
  assert.ok(typeof path === "string" && typeof jobId === "string");
  assert.ok(typeof startedAt === "number" && typeof storeKey === "string");
  assert.ok(receiptId === undefined || typeof receiptId === "string");
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      findCronRunRecoveryInDatabase({ database: db, jobId, startedAt, storeKey, receiptId }),
    { path },
  );
});
