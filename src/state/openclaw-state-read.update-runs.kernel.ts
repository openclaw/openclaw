/**
 * Update-run read commands for the shared-state read worker.
 *
 * Extracted as one coherent domain so the worker's dispatch chain stays within
 * its line cap; the branch semantics are unchanged from the inline form.
 */
import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  readInterruptedUpdateCandidate,
  readUpdateRunHistoryStatusInDatabase,
  readUpdateRunRecord,
  readUpdateRuns,
  readUpdateRunStatusInDatabase,
} from "../infra/update-run-read.kernel.js";
import {
  inspectUpdateRunReconciliation,
  readUpdateRunReconciliationCandidates,
} from "../infra/update-run-reconciliation.read.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

export type UpdateRunsReadCommand = Extract<
  OpenClawStateReadCommand,
  { type: `updateRuns.${string}` }
>;
type UpdateRunsReadResult = Extract<OpenClawStateReadResult, { type: `updateRuns.${string}` }>;

export function isUpdateRunsReadCommand(
  command: OpenClawStateReadCommand,
): command is UpdateRunsReadCommand {
  return command.type.startsWith("updateRuns.");
}

export function executeUpdateRunsRead(
  db: DatabaseSync,
  command: UpdateRunsReadCommand,
): UpdateRunsReadResult {
  if (command.type === "updateRuns.get") {
    return {
      type: command.type,
      run: tableExists(db, "update_runs") ? readUpdateRunRecord(db, command.runId) : undefined,
    };
  }
  if (command.type === "updateRuns.list") {
    return { type: command.type, runs: readUpdateRuns(db, command.input) };
  }
  if (command.type === "updateRuns.reconciliationCandidates") {
    return {
      type: command.type,
      candidates: readUpdateRunReconciliationCandidates(db, command.input),
    };
  }
  if (command.type === "updateRuns.reconciliationCandidate") {
    const run = tableExists(db, "update_runs") ? readUpdateRunRecord(db, command.runId) : undefined;
    return {
      type: command.type,
      candidate: run ? inspectUpdateRunReconciliation(db, run, {}) : undefined,
    };
  }
  if (command.type === "updateRuns.status") {
    return {
      type: command.type,
      status: runSqliteDeferredTransactionSync(db, () => readUpdateRunStatusInDatabase(db)),
    };
  }
  if (command.type === "updateRuns.historyStatus") {
    return {
      type: command.type,
      status: runSqliteDeferredTransactionSync(db, () => readUpdateRunHistoryStatusInDatabase(db)),
    };
  }
  return { type: command.type, run: readInterruptedUpdateCandidate(db) };
}
