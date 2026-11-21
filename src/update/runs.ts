// The update run row: one per update, written by the Gateway that runs the update and
// finished by the Gateway that starts after the switch (new on success, old after rollback).
import { randomUUID } from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { encodeRun } from "../infra/update-run-codec.js";
import { readUpdateRunRecord } from "../infra/update-run-read.kernel.js";
import {
  finishUpdateRunRecord,
  type UpdateRunPhase,
  type UpdateRunRecord,
  type UpdateRunStep,
} from "../infra/update-run-record.js";
import { upsertStep } from "../infra/update-run-step-upsert.js";
import { updateRunLedgerSchema } from "../infra/update-run-write.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

type Options = { env?: NodeJS.ProcessEnv };
type Ledger = Pick<DB, "update_runs">;

function write<T>(
  options: Options,
  operation: (db: Parameters<typeof readUpdateRunRecord>[0]) => T,
  firstUse = false,
) {
  return runExistingOpenClawStateWriteTransaction(({ db }) => operation(db), options, {
    schemaSql: updateRunLedgerSchema,
    operationLabel: "update.run",
    // The run row is the ledger's first writer on a fresh state database.
    initializeAdditiveSchema: firstUse,
  });
}

export function createRun(
  input: Pick<UpdateRunRecord, "trigger"> &
    Partial<Pick<UpdateRunRecord, "origin" | "target" | "before">>,
  options: Options = {},
): UpdateRunRecord {
  const now = Date.now();
  const record: UpdateRunRecord = {
    runId: randomUUID(),
    createdAtMs: now,
    updatedAtMs: now,
    trigger: input.trigger,
    phase: "requested",
    status: "running",
    reason: null,
    origin: input.origin ?? {},
    target: input.target ?? {},
    before: input.before ?? {},
    after: {},
    steps: [{ step: "requested", status: "in_progress", startedAtMs: now }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
  };
  const row = encodeRun(record, options);
  return write(
    options,
    (db) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Ledger>(db).insertInto("update_runs").values(row),
      );
      return readUpdateRunRecord(db, row.run_id)!;
    },
    true,
  );
}

/** Applies `mutate` to a running row; finished rows are never reopened. */
export function updateRun(
  runId: string,
  mutate: (record: UpdateRunRecord) => void,
  options: Options = {},
): UpdateRunRecord | undefined {
  return write(options, (db) => {
    const record = readUpdateRunRecord(db, runId);
    if (!record || record.status !== "running") {
      return record;
    }
    mutate(record);
    record.updatedAtMs = Date.now();
    const row = encodeRun(record, options);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Ledger>(db)
        .updateTable("update_runs")
        .set(row)
        .where("run_id", "=", runId),
    );
    return record;
  });
}

export function readRun(runId: string, options: Options = {}): UpdateRunRecord | undefined {
  return write(options, (db) => readUpdateRunRecord(db, runId));
}

/** Moves to `phase`: the current phase step completes and the new one starts. */
export function recordPhase(
  runId: string,
  phase: Exclude<UpdateRunPhase, "finished">,
  patch: Partial<Pick<UpdateRunRecord, "target" | "before" | "after">> = {},
  options: Options = {},
) {
  return updateRun(
    runId,
    (record) => {
      const now = Date.now();
      Object.assign(record.target, patch.target);
      Object.assign(record.before, patch.before);
      Object.assign(record.after, patch.after);
      if (record.phase !== phase) {
        upsertStep(record, { step: record.phase, status: "completed", endedAtMs: now });
        record.phase = phase;
        upsertStep(record, { step: phase, status: "in_progress", startedAtMs: now });
      }
    },
    options,
  );
}

export function recordStep(runId: string, step: UpdateRunStep, options: Options = {}) {
  return updateRun(runId, (record) => upsertStep(record, step), options);
}

export function finishRun(
  runId: string,
  result: {
    status: "succeeded" | "failed" | "skipped";
    reason?: string;
    nextAction?: string;
    after?: UpdateRunRecord["after"];
    verification?: UpdateRunRecord["verification"];
    detail?: string;
    downtimeMs?: number;
  },
  options: Options = {},
) {
  return updateRun(
    runId,
    (record) => {
      if (result.detail) {
        upsertStep(record, {
          step: "outcome",
          status: result.status === "succeeded" ? "completed" : "failed",
          endedAtMs: Date.now(),
          detail: result.detail,
        });
      }
      Object.assign(record.verification, result.verification);
      finishUpdateRunRecord(record, result);
    },
    options,
  );
}
