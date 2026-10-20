import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunDiagnosticsAsync,
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
  recordUpdateRunVerificationAsync,
} from "./update-run-write.async.js";

const admissionClock = vi.hoisted(() => ({ now: 0n, delayCommit: false, commits: 0 }));
vi.mock("./sqlite-worker-operation-admission.js", async (original) => {
  const actual = await original<typeof import("./sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...[admit, attachment]: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) =>
      actual.createSqliteWorkerOperationAdmission((request, grant) => {
        if (admissionClock.delayCommit && request.stage === "commit") {
          admissionClock.commits++;
          admissionClock.now += 1_000_000_000n;
        }
        admit(request, grant);
      }, attachment),
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    admissionClock.delayCommit = false;
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("warns when the real broker refuses optional progress but preserves required receipts", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-progress-capacity-") } };
  const run = await createUpdateRunAsync({ trigger: "cli" }, options);
  const held = createDeferred();
  let release = () => {};
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "message") {
      messages.mockRestore();
      release = () => {
        EventEmitter.prototype.emit.call(this, event, ...args);
      };
      held.resolve();
      return true;
    }
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
  const step = { step: "candidate-state-snapshot", status: "in_progress" as const };
  const accepted = Promise.allSettled(
    Array.from({ length: 128 }, () => recordUpdateRunStepAsync(run.runId, step, options)),
  );
  const waiting = createDeferred();
  const expirations: Array<() => void> = [];
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (ms === 10_000) {
      expirations.push(() => {
        clearTimeout(timer);
        callback(...args);
      });
      if (expirations.length === 2) {
        waiting.resolve();
      }
    }
    return timer;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await held.promise;
    const optional = recordUpdateRunStepAsync(run.runId, step, options);
    const required = recordUpdateRunStepAsync(
      run.runId,
      { step: "finalize:checkpoint", status: "completed" },
      options,
    );
    const outcomes = Promise.allSettled([optional, required]);
    await waiting.promise;
    for (const expire of expirations) {
      expire();
    }
    expect(await outcomes).toMatchObject([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: { code: "overloaded" } },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("The update will continue"));
  } finally {
    vi.restoreAllMocks();
    release();
    expect((await accepted).every((result) => result.status === "fulfilled")).toBe(true);
  }
  expect((await finishUpdateRunAsync(run.runId, { status: "succeeded" }, options)).status).toBe(
    "succeeded",
  );
});

it("warns on exhausted progress admission and keeps the real worker usable", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-progress-admission-") } };
  const run = await createUpdateRunAsync({ trigger: "cli" }, options);
  admissionClock.now = process.hrtime.bigint();
  admissionClock.commits = 0;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => admissionClock.now);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  admissionClock.delayCommit = true;
  try {
    await expect(
      recordUpdateRunStepAsync(
        run.runId,
        { step: "candidate-state-snapshot", status: "in_progress" },
        { ...options, requireNoRecovery: true },
      ),
    ).resolves.toBeUndefined();
  } finally {
    admissionClock.delayCommit = false;
  }
  expect(admissionClock.commits).toBe(3);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("The update will continue"));
  await recordUpdateRunPhaseAsync(run.runId, "validating", {}, options);
  const saved = await getUpdateRunAsync(run.runId, options);
  expect(saved?.phase).toBe("validating");
  expect(saved?.steps.some((step) => step.step === "candidate-state-snapshot")).toBe(false);
});

it("records Gateway update history off-thread and publishes merged writes to warm readers", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("update-mutations-") } };
  const warn = vi.fn();
  const sql = observeMainThreadSql();
  sql.calibrate();
  let nativeCalls = 0;
  try {
    const run = await createUpdateRunAsync({ trigger: "api" }, options);
    expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({ status: "running" });
    await Promise.all([
      recordUpdateRunPhaseAsync(
        run.runId,
        "validating",
        { target: { version: "2026.10.1" } },
        options,
      ),
      recordUpdateRunStepAsync(
        run.runId,
        { step: "notice:activating", status: "completed" },
        options,
      ),
      recordUpdateRunVerificationAsync(run.runId, { booted: true }, options),
      recordUpdateRunDiagnosticsAsync(
        run.runId,
        {
          rollbackOutcome: { status: "not-needed", reason: "fixture update" },
        },
        warn,
        options,
      ),
    ]);
    expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({
      phase: "validating",
      target: { version: "2026.10.1" },
      verification: { booted: true, rollbackOutcome: { status: "not-needed" } },
      steps: expect.arrayContaining([{ step: "notice:activating", status: "completed" }]),
    });
    await finishUpdateRunAsync(
      run.runId,
      { status: "succeeded", after: { version: "2026.10.1" } },
      options,
    );
    await recordUpdateRunVerificationAsync(
      run.runId,
      { booted: false },
      { ...options, onlyIfRunning: true },
    );
    expect(await getUpdateRunAsync(run.runId, options)).toMatchObject({
      phase: "finished",
      status: "succeeded",
      after: { version: "2026.10.1" },
      verification: { booted: true },
    });
    await recordUpdateRunVerificationAsync(run.runId, { noticeDelivered: true }, options);
    await recordUpdateRunVerificationAsync(run.runId, { noticeDelivered: false }, options);
    expect((await getUpdateRunAsync(run.runId, options))?.verification.noticeDelivered).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    nativeCalls = sql.count();
  } finally {
    sql.restore();
  }
  expect(nativeCalls).toBe(0);
});
