import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isPostgresSqlConnection } from "./sql-connection.js";
import { readSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import { captureUpdateRunRedactionFacts } from "./update-run-codec.js";
import { executeUpdateRunCommand } from "./update-run-dispatch.worker.js";
import { persistInterruptedUpdateObservation } from "./update-run-interruption-store.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import type { UpdateRunWriteCommand } from "./update-run-mutation.types.js";
import {
  openUpdateRunWriter,
  recordUpdateRunMutationInWorker,
} from "./update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker } from "./update-run-reconciliation.worker.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let options: { env: { HOME: string; OPENCLAW_STATE_DIR: string } };
let runId: string;
let writer: ReturnType<typeof openUpdateRunWriter>;

beforeAll(async () => {
  const home = dirs.make("update-run-contention-");
  options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
  createUpdateRun(
    { trigger: "cli", settlement: { reason: "fixture", detail: "fixture" } },
    options,
  );
  await closeOpenClawStateDatabaseAsync();
});

beforeEach(async () => {
  runId = createUpdateRun({ trigger: "cli" }, options).runId;
  await closeOpenClawStateDatabaseAsync();
  writer = openUpdateRunWriter(options);
});

afterEach(async () => {
  vi.restoreAllMocks();
  writer.close();
  await closeOpenClawStateDatabaseAsync();
});

function busyError() {
  return Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "database is locked",
  });
}

function retentionCommand(
  handedOff = true,
): Extract<UpdateRunWriteCommand, { type: "updateRuns.recordStep" }> {
  const guards = createUpdateCommandExecutionGuards(
    { run: { runId, env: options.env } },
    options.env.HOME,
  );
  if (handedOff) {
    guards.onStateHandoff();
  }
  const captured = guards.captureWriteOptions();
  return {
    type: "updateRuns.recordStep",
    input: {
      runId,
      redactionFacts: captureUpdateRunRedactionFacts(options.env),
      requireNoRecovery: captured.requireNoRecovery,
      busyTimeoutMs: captured.busyTimeoutMs,
      step: { step: "updater-runtime-retention", status: "completed" },
    },
  };
}

function mutate(
  command = retentionCommand(),
  admit: Parameters<typeof recordUpdateRunMutationInWorker>[2] = vi.fn(),
) {
  return recordUpdateRunMutationInWorker(command, options, admit, () => writer);
}

it.each(["progress", "required", "transient"] as const)(
  "settles %s update receipts when the host policy check exceeds commit admission",
  (kind) => {
    const command = retentionCommand(false);
    command.input.step = {
      step: kind === "required" ? "finalize:checkpoint" : "candidate-state-snapshot",
      status: "in_progress",
    };
    let now = process.hrtime.bigint();
    let commits = 0;
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      if (request.stage === "commit") {
        commits++;
        // Bound the broken implementation without letting an infinite retry hang the suite.
        if (commits > 3) {
          throw new Error("update receipt retried beyond its bound");
        }
        if (kind !== "transient" || commits === 1) {
          now += 1_000_000_000n;
        }
      }
      grant();
    });
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      admission.service();
      return "ok";
    });
    try {
      const write = () =>
        withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          executeUpdateRunCommand(command, options, () => writer),
        );
      if (kind === "required") {
        expect(write).toThrow("Update history could not obtain commit admission after 3 attempts");
      } else {
        expect(write()).toMatchObject({
          kind: kind === "progress" ? "bookkeeping-skipped" : "recorded",
        });
      }
      expect(commits).toBe(kind === "transient" ? 2 : 3);
    } finally {
      admission.finish();
    }
    const saved = getUpdateRun(runId, options);
    expect(saved?.steps.some((step) => step.step === command.input.step.step)).toBe(
      kind === "transient",
    );
    // Every expired attempt rolled back and released the writer, including the last one.
    using competitor = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
    competitor.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK;");
  },
);

it("warns on contended bookkeeping and still records the required outcome", () => {
  const write = vi
    .spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction")
    .mockImplementationOnce(() => {
      throw busyError();
    });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    recordUpdateRunStep(
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
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
  expect(finishUpdateRun(runId, { status: "succeeded" }, options).status).toBe("succeeded");
});

it("keeps Gateway verification at the ordinary writer budget", () => {
  const write = vi
    .spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction")
    .mockImplementationOnce(() => {
      throw busyError();
    });
  expect(() => recordUpdateRunVerification(runId, { booted: true }, options)).toThrow(
    "database is locked",
  );
  expect(write).toHaveBeenCalledWith(
    expect.any(Function),
    options,
    expect.objectContaining({ busyTimeoutMs: undefined }),
  );
  expect(getUpdateRun(runId, options)?.verification.booted).toBeUndefined();
});

it.each([true, false])(
  "retains the native budget for required writes (handed off=%s)",
  (handedOff) => {
    const command = retentionCommand(handedOff);
    if (handedOff) {
      command.input.step.step = "finalize:predecessor-stop:fixture";
    }
    const run = vi.spyOn(writer, "run").mockImplementationOnce(() => {
      throw busyError();
    });
    expect(() => mutate(command)).toThrow(
      handedOff ? /database is locked.*retry `openclaw update`/ : /required recovery evidence/,
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.objectContaining({ busyTimeoutMs: 120_000 }),
    );
    if (handedOff) {
      expect(mutate(command)).toMatchObject({
        kind: "recorded",
        record: {
          steps: expect.arrayContaining([
            { step: "finalize:predecessor-stop:fixture", status: "completed" },
          ]),
        },
      });
    }
  },
);

it("skips a real SQLite writer lock without waiting or creating a receipt", () => {
  const command = retentionCommand();
  command.input.busyTimeoutMs = 0;
  const blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  try {
    blocker.exec("BEGIN IMMEDIATE");
    expect(mutate(command)).toEqual({
      kind: "bookkeeping-skipped",
    });
    expect(blocker.isTransaction).toBe(true);
  } finally {
    if (blocker.isTransaction) {
      blocker.exec("ROLLBACK");
    }
    blocker.close();
  }
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
});

it("does not swallow a non-contention failure as bookkeeping", () => {
  const failure = new Error("fixture writer failure");
  vi.spyOn(writer, "run").mockImplementationOnce(() => {
    throw failure;
  });
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

it.each([
  [
    "progress step",
    (admit: (stage: "transaction" | "commit") => void) =>
      mutate(
        {
          type: "updateRuns.recordStep",
          input: {
            runId,
            redactionFacts: captureUpdateRunRedactionFacts(options.env),
            step: { step: "candidate-state-snapshot", status: "in_progress" },
          },
        },
        admit,
      ),
    ["transaction:free", "commit:held"],
  ],
  [
    "run creation",
    (admit: (stage: "transaction" | "commit") => void) =>
      createUpdateRun({ trigger: "cli" }, options, admit),
    ["transaction:free", "commit:held"],
  ],
  [
    "reconciliation",
    (admit: (stage: "transaction" | "commit") => void) =>
      reconcileUpdateRunCandidatesInWorker({ candidates: [], selection: {} }, options, admit),
    ["transaction:free", "commit:held"],
  ],
  [
    "interruption settlement",
    (admit: (stage: "transaction" | "commit") => void) =>
      persistInterruptedUpdateObservation(
        { expected: { ...getUpdateRun(runId, options)!, updatedAtMs: 0 }, detail: "fixture" },
        options,
        admit,
      ),
    ["transaction:free"],
  ],
])("leaves the writer free while the host decides %s admission", (_name, write, expected) => {
  const competitor = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  competitor.exec("PRAGMA busy_timeout = 0");
  const observed: string[] = [];
  try {
    write((stage) => {
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
    });
  } finally {
    competitor.close();
  }
  expect(observed).toEqual(expected);
});

it("does not replay or discard a lock failure after transaction admission", () => {
  const cause = busyError();
  const admit = vi.fn((stage) => {
    if (stage === "commit") {
      throw cause;
    }
  });
  expect(() => mutate(retentionCommand(), admit)).toThrow(cause);
  expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
});
