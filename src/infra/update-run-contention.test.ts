import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { captureUpdateRunRedactionFacts, isRetainedStep } from "./update-run-codec.js";
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

it.each([
  "updater-runtime-retention",
  "diagnostic:updater-runtime-retention",
  "candidate-state-snapshot",
  "update-driver-handoff",
])("skips contended bookkeeping even when history retains %s", (step) => {
  const command = retentionCommand();
  command.input.step.step = step;
  expect(isRetainedStep(command.input.step)).toBe(true);
  const run = vi.spyOn(writer, "run").mockImplementation(() => {
    throw busyError();
  });
  const current = vi.fn();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(recordUpdateRunMutationInWorker(command, options, current, () => writer)).toEqual({
      kind: "bookkeeping-skipped",
    });
  }
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenLastCalledWith(
    expect.any(Function),
    expect.objectContaining({ busyTimeoutMs: 1_000 }),
  );
  expect(current).not.toHaveBeenCalled();
  expect(getUpdateRun(runId, options)?.steps.some((entry) => entry.step === step)).toBe(false);
});

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

it.each(["finalize:predecessor-stop:fixture", "openclaw doctor", "package rollback"])(
  "gives recovery-critical %s the driver's native busy budget",
  (step) => {
    const command = retentionCommand();
    command.input.step.step = step;
    const cause = busyError();
    const run = vi.spyOn(writer, "run").mockImplementationOnce(() => {
      throw cause;
    });
    expect(() => recordUpdateRunMutationInWorker(command, options, vi.fn(), () => writer)).toThrow(
      /database is locked.*retry `openclaw update`/,
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.objectContaining({ busyTimeoutMs: 120_000 }),
    );
    expect(recordUpdateRunMutationInWorker(command, options, vi.fn(), () => writer)).toMatchObject({
      kind: "recorded",
      record: { steps: expect.arrayContaining([{ step, status: "completed" }]) },
    });
  },
);

it("does not turn required recovery admission into optional bookkeeping", () => {
  const command = retentionCommand(false);
  const run = vi.spyOn(writer, "run").mockImplementationOnce(() => {
    throw busyError();
  });
  expect(() => recordUpdateRunMutationInWorker(command, options, vi.fn(), () => writer)).toThrow(
    /required recovery evidence/,
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.objectContaining({ busyTimeoutMs: 120_000 }),
  );
});

it("skips a real SQLite writer lock without waiting or creating a receipt", () => {
  const command = retentionCommand();
  command.input.busyTimeoutMs = 0;
  const blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  try {
    blocker.exec("BEGIN IMMEDIATE");
    expect(recordUpdateRunMutationInWorker(command, options, vi.fn(), () => writer)).toEqual({
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
  expect(() =>
    recordUpdateRunMutationInWorker(retentionCommand(), options, vi.fn(), () => writer),
  ).toThrow(failure);
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
  recordUpdateRunMutationInWorker(retentionCommand(false), options, vi.fn(), () => writer);
  expect(timeout).toBe(5_000);
  expect(connection && readSqliteBusyTimeout(connection)).toBe(5_000);
});

it("does not replay or discard a lock failure after transaction admission", () => {
  const cause = busyError();
  const admit = vi.fn((stage) => {
    if (stage === "commit") {
      throw cause;
    }
  });
  expect(() =>
    recordUpdateRunMutationInWorker(retentionCommand(), options, admit, () => writer),
  ).toThrow(cause);
  expect(admit.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
});
