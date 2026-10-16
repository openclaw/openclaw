import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateCommandExecutionGuards as executionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import { closeOpenClawStateDatabaseAsync as closeState } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as databasePath } from "../state/openclaw-state-db.paths.js";
import { isPostgresSqlConnection } from "./sql-connection.js";
import { readSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { captureUpdateRunRedactionFacts as redactionFacts } from "./update-run-codec.js";
import { persistInterruptedUpdateObservation as persistInterruption } from "./update-run-interruption-store.js";
import {
  createUpdateRun as createRun,
  finishUpdateRun as finishRun,
  getUpdateRun as getRun,
  recordUpdateRunStep as recordStep,
  recordUpdateRunVerification as recordVerification,
} from "./update-run-ledger.js";
import type { UpdateRunWriteCommand } from "./update-run-mutation.types.js";
import {
  openUpdateRunWriter,
  recordUpdateRunMutationInWorker as recordMutation,
} from "./update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker as reconcileCandidates } from "./update-run-reconciliation.worker.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let options: { env: { HOME: string; OPENCLAW_STATE_DIR: string } };
let runId: string;
let writer: ReturnType<typeof openUpdateRunWriter>;
type Admission = (stage: "transaction" | "commit") => void;
type StepCommand = Extract<UpdateRunWriteCommand, { type: "updateRuns.recordStep" }>;

beforeAll(() => {
  const home = dirs.make("update-run-contention-");
  options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
});

beforeEach(async () => {
  runId = createRun({ trigger: "cli" }, options).runId;
  await closeState();
  writer = openUpdateRunWriter(options);
});

afterEach(async () => {
  vi.restoreAllMocks();
  writer.close();
  await closeState();
});

function busyError() {
  return Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "database is locked",
  });
}

function mutate(command: UpdateRunWriteCommand = retentionCommand(), admit: Admission = vi.fn()) {
  return recordMutation(command, options, admit, () => writer);
}

function failRun(error = busyError()) {
  return vi.spyOn(writer, "run").mockImplementationOnce(() => {
    throw error;
  });
}

function stepCommand(step: StepCommand["input"]["step"]): StepCommand {
  return {
    type: "updateRuns.recordStep",
    input: {
      runId,
      redactionFacts: redactionFacts(options.env),
      step,
    },
  };
}

function failNextWrite() {
  return vi
    .spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction")
    .mockImplementationOnce(() => {
      throw busyError();
    });
}

function retentionCommand(handedOff = true): StepCommand {
  const guards = executionGuards({ run: { runId, env: options.env } }, options.env.HOME);
  if (handedOff) {
    guards.onStateHandoff();
  }
  const captured = guards.captureWriteOptions();
  const command = stepCommand({ step: "updater-runtime-retention", status: "completed" });
  Object.assign(command.input, {
    requireNoRecovery: captured.requireNoRecovery,
    busyTimeoutMs: captured.busyTimeoutMs,
  });
  return command;
}

it("warns on contended bookkeeping and still records the required outcome", () => {
  const write = failNextWrite();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    recordStep(
      runId,
      { step: "updater-runtime-retention", status: "completed" },
      { ...options, busyTimeoutMs: 120_000 },
    ),
  ).toBeUndefined();
  expect(write).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ busyTimeoutMs: 1_000 }),
    expect.objectContaining({ busyTimeoutMs: 1_000 }),
  );
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("The update will continue"));
  expect(getRun(runId, options)?.steps).toHaveLength(1);
  expect(finishRun(runId, { status: "succeeded" }, options).status).toBe("succeeded");
});

it("keeps Gateway verification at the ordinary writer budget", () => {
  const write = failNextWrite();
  expect(() => recordVerification(runId, { booted: true }, options)).toThrow("database is locked");
  expect(write).toHaveBeenCalledWith(
    expect.any(Function),
    options,
    expect.objectContaining({ busyTimeoutMs: undefined }),
  );
  expect(getRun(runId, options)?.verification.booted).toBeUndefined();
});

it.each([true, false])("uses the required recovery budget (critical step=%s)", (critical) => {
  const command = retentionCommand(critical);
  if (critical) {
    command.input.step.step = "finalize:predecessor-stop:fixture";
  }
  const run = failRun();
  expect(() => mutate(command)).toThrow(
    critical ? /database is locked.*retry `openclaw update`/ : /required recovery evidence/,
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.objectContaining({ busyTimeoutMs: 120_000 }),
  );
  if (critical) {
    expect(mutate(command)).toMatchObject({
      kind: "recorded",
      record: {
        steps: expect.arrayContaining([
          { step: "finalize:predecessor-stop:fixture", status: "completed" },
        ]),
      },
    });
  }
});

it("skips a real SQLite writer lock without waiting or creating a receipt", () => {
  const command = retentionCommand();
  command.input.busyTimeoutMs = 0;
  const blocker = new DatabaseSync(databasePath(options.env));
  try {
    blocker.exec("BEGIN IMMEDIATE");
    expect(mutate(command)).toEqual({ kind: "bookkeeping-skipped" });
    expect(blocker.isTransaction).toBe(true);
  } finally {
    if (blocker.isTransaction) {
      blocker.exec("ROLLBACK");
    }
    blocker.close();
  }
  expect(getRun(runId, options)?.steps).toHaveLength(1);
});

it("does not swallow a non-contention failure as bookkeeping", () => {
  const failure = new Error("fixture writer failure");
  failRun(failure);
  expect(() => mutate()).toThrow(failure);
});

it("restores the ordinary transaction wait after driver admission", () => {
  const run = writer.run.bind(writer);
  let timeout: number | undefined;
  let connection: DatabaseSync | undefined;
  vi.spyOn(writer, "run").mockImplementation((operation, current) =>
    run((database) => {
      const { db } = database;
      if (isPostgresSqlConnection(db)) {
        throw new Error("The busy-timeout fixture requires SQLite");
      }
      const result = operation(database);
      connection = db;
      timeout = readSqliteBusyTimeout(db);
      return result;
    }, current),
  );
  mutate(retentionCommand(false));
  expect(timeout).toBe(5_000);
  expect(connection && readSqliteBusyTimeout(connection)).toBe(5_000);
});

it.each(["progress step", "run creation", "reconciliation", "interruption settlement"] as const)(
  "leaves the writer free while the host decides %s admission",
  (operation) => {
    const competitor = new DatabaseSync(databasePath(options.env));
    competitor.exec("PRAGMA busy_timeout = 0");
    const observed: string[] = [];
    const admit: Admission = (stage) => {
      try {
        competitor.exec("BEGIN IMMEDIATE");
        competitor.exec("ROLLBACK");
        observed.push(`${stage}:free`);
      } catch (error) {
        if (!isSqliteLockError(error)) {
          throw error;
        }
        observed.push(`${stage}:held`);
      }
    };
    const writes = {
      "progress step": () =>
        mutate(stepCommand({ step: "candidate-state-snapshot", status: "in_progress" }), admit),
      "run creation": () => createRun({ trigger: "cli" }, options, admit),
      reconciliation: () => reconcileCandidates({ candidates: [], selection: {} }, options, admit),
      "interruption settlement": () =>
        persistInterruption(
          { expected: { ...getRun(runId, options)!, updatedAtMs: 0 }, detail: "fixture" },
          options,
          admit,
        ),
    };
    try {
      writes[operation]();
    } finally {
      competitor.close();
    }
    expect(observed).toEqual(
      operation === "interruption settlement"
        ? ["transaction:free"]
        : ["transaction:free", "commit:held"],
    );
  },
);

it("does not replay or discard a lock failure after transaction admission", () => {
  const cause = busyError();
  const admit = vi.fn((stage) => {
    if (stage === "commit") {
      throw cause;
    }
  });
  expect(() => mutate(retentionCommand(), admit)).toThrow(cause);
  expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(getRun(runId, options)?.steps).toHaveLength(1);
});
