import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { captureUpdateRunRedactionFacts } from "./update-run-codec.js";
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

const dirs = useAutoCleanupTempDirTracker(afterAll);
let options: { env: { HOME: string; OPENCLAW_STATE_DIR: string } };
let runId: string;
let blocker: DatabaseSync;
let writer: ReturnType<typeof openUpdateRunWriter>;
let elapsed: number;

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
  blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  writer = openUpdateRunWriter(options);
  elapsed = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (blocker.isTransaction) {
    blocker.exec("ROLLBACK");
  }
  blocker.close();
  writer.close();
  await closeOpenClawStateDatabaseAsync();
});

// Keep real SQLite contention, but account for its wait only after the ledger
// attempt returns SQLITE_BUSY. Unrelated native waits must not release this lock.
function holdWriter(untilMs: number, onRelease?: () => void) {
  blocker.exec("BEGIN IMMEDIATE");
  const release = () => {
    if (blocker.isTransaction) {
      blocker.exec("COMMIT");
      onRelease?.();
    }
  };
  const attempt = <T>(write: () => T, budget = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS): T => {
    try {
      return write();
    } catch (error) {
      if (isSqliteLockError(error)) {
        writer.assertSettled();
        elapsed += Math.min(budget, untilMs - elapsed);
        if (elapsed >= untilMs) {
          release();
        }
        if (!blocker.isTransaction) {
          return write();
        }
      }
      throw error;
    }
  };
  const run = writer.run.bind(writer);
  vi.spyOn(writer, "run").mockImplementation((operation, current) =>
    attempt(() => run(operation, { ...current, busyTimeoutMs: 0 }), current.busyTimeoutMs),
  );
  const write = existingWrites.runExistingOpenClawStateWriteTransaction;
  vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
    (operation, current, contract) => {
      const immediate = { ...current, busyTimeoutMs: 0 };
      return attempt(
        () => write(operation, immediate, { ...contract, busyTimeoutMs: 0 }),
        contract.busyTimeoutMs,
      );
    },
  );
  return release;
}

function driverWriteOptions(handedOff = false) {
  const guards = createUpdateCommandExecutionGuards(
    { run: { runId, env: options.env } },
    options.env.HOME,
  );
  if (handedOff) {
    guards.onStateHandoff();
  }
  return guards.captureWriteOptions();
}

function retentionCommand(
  driver = false,
  handedOff = false,
): Extract<UpdateRunWriteCommand, { type: "updateRuns.recordStep" }> {
  const captured = driver ? driverWriteOptions(handedOff) : undefined;
  return {
    type: "updateRuns.recordStep",
    input: {
      runId,
      redactionFacts: captureUpdateRunRedactionFacts(options.env),
      requireNoRecovery: captured?.requireNoRecovery,
      busyTimeoutMs: captured?.busyTimeoutMs,
      step: { step: "updater-runtime-retention", status: "completed" },
    },
  };
}

it("keeps Gateway verification within its existing five-second lock budget", () => {
  holdWriter(Infinity);
  expect(() => recordUpdateRunVerification(runId, { booted: true }, options)).toThrow(/locked/);
  expect(elapsed).toBe(5_000);
  expect(getUpdateRun(runId, options)?.verification.booted).toBeUndefined();
});

it("records retention after a writer outlasts five seconds without skipping recovery admission", () => {
  holdWriter(107_000);
  const assertCurrent = vi.fn();
  const result = recordUpdateRunMutationInWorker(
    retentionCommand(true),
    options,
    assertCurrent,
    writer,
  );
  expect(elapsed).toBeGreaterThanOrEqual(107_000);
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(result).toMatchObject({ kind: "recorded", record: { runId } });
  expect(assertCurrent.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(getUpdateRun(runId, options)?.steps).toContainEqual({
    step: "updater-runtime-retention",
    status: "completed",
  });
});

it("skips contended bookkeeping without claiming a committed worker receipt", () => {
  const release = holdWriter(Infinity);
  expect(
    recordUpdateRunMutationInWorker(retentionCommand(true, true), options, vi.fn(), writer),
  ).toEqual({
    kind: "bookkeeping-skipped",
  });
  expect(elapsed).toBe(1_000);
  expect(blocker.isTransaction).toBe(true);
  release();
  expect(
    getUpdateRun(runId, options)?.steps.some((step) => step.step === "updater-runtime-retention"),
  ).toBe(false);
});

it("warns and continues synchronous bookkeeping, then records the required outcome after contention", () => {
  holdWriter(6_000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    recordUpdateRunStep(
      runId,
      { step: "updater-runtime-retention", status: "completed" },
      {
        ...options,
        busyTimeoutMs: driverWriteOptions().busyTimeoutMs,
      },
    ),
  ).toBeUndefined();
  expect(elapsed).toBe(1_000);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("The update will continue"));
  expect(blocker.isTransaction).toBe(true);
  expect(finishUpdateRun(runId, { status: "succeeded" }, options).status).toBe("succeeded");
  expect(elapsed).toBeGreaterThanOrEqual(6_000);
  expect(getUpdateRun(runId, options)?.status).toBe("succeeded");
});

it("does not advance a phase when recovery evidence cannot be committed within the budget", () => {
  holdWriter(Infinity);
  expect(() =>
    recordUpdateRunMutationInWorker(
      {
        type: "updateRuns.recordPhase",
        input: {
          runId,
          phase: "activating",
          patch: {},
          redactionFacts: captureUpdateRunRedactionFacts(options.env),
          busyTimeoutMs: driverWriteOptions().busyTimeoutMs,
        },
      },
      options,
      vi.fn(),
      writer,
    ),
  ).toThrow(/database is locked.*retry `openclaw update`/);
  expect(elapsed).toBe(120_000);
  expect(getUpdateRun(runId, options)?.phase).toBe("requested");
});

it.each(["finalize:predecessor-stop:fixture", "openclaw doctor", "package rollback"])(
  "retains recovery-critical %s receipts after a prolonged lock",
  (step) => {
    holdWriter(6_000);
    const command = retentionCommand(true, true);
    command.input.step.step = step;
    expect(recordUpdateRunMutationInWorker(command, options, vi.fn(), writer)).toMatchObject({
      kind: "recorded",
      record: { steps: expect.arrayContaining([{ step, status: "completed" }]) },
    });
    expect(elapsed).toBeGreaterThanOrEqual(6_000);
  },
);

it("rechecks live authority after contention and rolls back a revoked write", () => {
  let revoked = false;
  holdWriter(6_000, () => {
    revoked = true;
  });
  expect(() =>
    recordUpdateRunMutationInWorker(
      retentionCommand(true),
      options,
      () => {
        if (revoked) {
          throw new Error("update authority revoked");
        }
      },
      writer,
    ),
  ).toThrow("update authority revoked");
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
});

it("does not swallow a non-contention failure as bookkeeping", () => {
  expect(() =>
    recordUpdateRunStep(
      "missing-run",
      { step: "updater-runtime-retention", status: "completed" },
      options,
    ),
  ).toThrow("Unknown update run");
});

it("restores the ordinary transaction wait after driver admission", () => {
  const run = writer.run.bind(writer);
  let timeout: number | undefined;
  let connection: DatabaseSync | undefined;
  vi.spyOn(writer, "run").mockImplementation((operation, current) =>
    run((database) => {
      const result = operation(database);
      connection = database.db;
      timeout = readSqliteBusyTimeout(database.db);
      return result;
    }, current),
  );
  recordUpdateRunMutationInWorker(retentionCommand(true), options, vi.fn(), writer);
  expect(timeout).toBe(5_000);
  expect(connection && readSqliteBusyTimeout(connection)).toBe(5_000);
});

it("does not replay or discard a lock failure after transaction admission", () => {
  const cause = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  const admit = vi.fn((stage) => {
    if (stage === "commit") {
      throw cause;
    }
  });
  expect(() => recordUpdateRunMutationInWorker(retentionCommand(), options, admit, writer)).toThrow(
    cause,
  );
  expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
});
