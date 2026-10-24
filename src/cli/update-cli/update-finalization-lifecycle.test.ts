import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { inspectUpdateRunAbandonment } from "../../infra/update-run-activity.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  ABANDONED_UPDATE_RUN_MS,
  UPDATE_RUN_HEARTBEAT_MS,
} from "../../infra/update-run-timeouts.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as cliExit from "../one-shot-exit.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { expectMessages } from "./update-boundary.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";
import { captureUpdateFinalizationDoctorOutput } from "./update-finalization-output.js";

const dirs = createTempDirTracker();
let stderrWrite: MockInstance<typeof process.stderr.write>;

function finalization(timeoutMs: number | undefined, json = false, attach = true) {
  const stopChildren = vi.fn();
  const lifecycle = new UpdateFinalizationLifecycle(json, timeoutMs, stopChildren);
  let runId: string | undefined;
  if (attach) {
    runId = lifecycle.attachLedger();
  }
  const read = () => getUpdateRun((runId ??= listUpdateRuns()[0]!.runId))!;
  function hold(phase: Parameters<typeof lifecycle.run>[0]) {
    const work = createDeferredCore();
    const entered = createDeferredCore();
    const running = withCliProcessScope(() =>
      lifecycle.run(phase, () => {
        entered.resolve();
        return work.promise;
      }),
    );
    return { work, entered: entered.promise, running };
  }
  return { lifecycle, stopChildren, read, hold };
}

it("reports standalone repair as repairing before Doctor maintenance", () => {
  const lifecycle = new UpdateFinalizationLifecycle(false, undefined, () => {});
  const runId = lifecycle.attachLedger(true);
  lifecycle.recordInstallKind("package", "2026.10.5");
  expect(getUpdateRun(runId)).toMatchObject({
    phase: "repairing",
    status: "running",
    target: { kind: "package", version: "2026.10.5" },
  });
});

it("writes successful finalization progress to stderr and failures as errors", async () => {
  const logPath = path.join(dirs.make("openclaw-finalize-log-"), "openclaw.log");
  setLoggerOverride({ level: "info", file: logPath });
  const { lifecycle } = finalization(5_000, false, false);
  await lifecycle.run("doctor", async () => undefined);
  expectMessages(stderrWrite, '"status":"in_progress"', '"status":"completed"');
  await flushLogger();
  const phaseRecords = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => JSON.stringify(record).includes("finalize:doctor"));
  expect(phaseRecords).toMatchObject([
    { _meta: { logLevelName: "INFO" } },
    { _meta: { logLevelName: "INFO" } },
  ]);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  lifecycle.recordWarnings(["A plugin update was deferred."]);
  expectMessages(console.warn, '"step":"warning:finalize:doctor:0"');
  await expect(
    lifecycle.run("plugins", async () => {
      throw new Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  expectMessages(defaultRuntime.error, '"status":"failed"');
  lifecycle.fail();
});

it("preserves Doctor duration and section diagnostics in run history", () => {
  const name = "pre-plugin doctor";
  const { lifecycle, read } = finalization(5_000);
  const endedAtMs = Date.now();
  lifecycle.recordDoctorStep({
    name,
    command: "openclaw doctor --repair",
    cwd: "/fixture",
    durationMs: 3_400,
    exitCode: 0,
    diagnostics: ["Doctor sections: config-flow 3.4 s"],
  });
  const run = read();
  expect(run.steps).toEqual(
    expect.arrayContaining(
      [name, `diagnostic:${name}`].map((step) =>
        expect.objectContaining({ step, startedAtMs: endedAtMs - 3_400, endedAtMs }),
      ),
    ),
  );
});

it("records a nested Doctor refusal before reporting standalone finalization", async () => {
  const { lifecycle, read } = finalization(5_000);
  const message =
    "Doctor could not enter maintenance. Error: The update parent owns Gateway activation.";
  const privatePath = "/home/example/private-doctor-input";
  await expect(
    lifecycle.run("doctor", async () => {
      const refusal = new UpdateDoctorError(
        `${message} ${privatePath}`,
        [{ check: "doctor", code: "doctor-failed", message }],
        { exitCode: 23 },
      );
      const recording = new Error("Warning output failed");
      throw new AggregateError([refusal, recording], "Doctor result recording failed", {
        cause: recording,
      });
    }),
  ).rejects.toThrow("Doctor result recording failed");
  lifecycle.fail();
  expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).not.toContain(privatePath);
  closeOpenClawStateDatabaseForTest();
  const run = read();
  expect(run).toMatchObject({
    status: "failed",
    reason: "doctor-failed",
    steps: expect.arrayContaining([
      expect.objectContaining({
        step: "finalize:doctor",
        status: "failed",
        exitCode: 23,
        failureFacts: [{ check: "doctor", code: "doctor-failed", message }],
      }),
    ]),
  });
  const report = await prepareUpdateFailureReport({
    attemptId: run.runId,
    recordedRun: run,
    result: resultFixture(undefined, { status: "error", mode: "unknown", durationMs: 1 }),
  });
  expect(report.body).toContain("Reason code: doctor-failed");
  expect(report.body).toContain(`Failed phase finalize-doctor: exit 23 (${message})`);
  expect(report.body).not.toContain("Failed phase finalize-doctor: exit unknown");
});

it("records the plugin failure reason without finishing an inherited run", async () => {
  const inherited = ledger.createUpdateRun({ trigger: "cli" });
  vi.stubEnv(UPDATE_RUN_ID_ENV, inherited.runId);
  const { lifecycle } = finalization(5_000);
  await expect(
    lifecycle.run("plugins", async () => {
      throw new Error("phase failed");
    }),
  ).rejects.toThrow("phase failed");
  lifecycle.fail();
  expect(getUpdateRun(inherited.runId)).toMatchObject({
    status: "running",
    reason: "finalize:plugins",
  });
  ledger.finishUpdateRun(inherited.runId, { status: "failed", reason: "parent-failure" });
  expect(getUpdateRun(inherited.runId)?.reason).toBe("parent-failure");
});

it("records a returned failed outcome without requiring an exception", async () => {
  const { lifecycle, read } = finalization(5_000);
  await lifecycle.run(
    "plugins",
    async () => undefined,
    () => ({
      outcome: "failed",
      failureFacts: [{ check: "plugin-update", code: "plugin-update-failed" }],
    }),
  );
  lifecycle.complete(1);
  expect(read()).toMatchObject({ status: "failed", reason: "plugin-update-failed" });
});

it.each(["failed", "completed"] as const)(
  "settles a late completion-cache result without hiding its outcome (%s)",
  async (outcome) => {
    // Exclude performance from fake timers and map it to the mocked wall clock
    // so admission (performance.now() + budget) and inspection stay in one domain.
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const { lifecycle, read } = finalization(1_000, true);
    const entered = createDeferredCore();
    const work = createDeferredCore<typeof outcome>();
    const running = withCliProcessScope(() =>
      lifecycle.run(
        "completionCache",
        async () => {
          entered.resolve();
          return await work.promise;
        },
        (result) => result,
      ),
    ).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await entered.promise;
    expect(read()?.status).toBe("running");
    vi.setSystemTime(Date.now() + 1_001);
    work.resolve(outcome);
    const result = await running;
    if (outcome === "completed") {
      expect(result.error).toMatchObject({
        message: expect.stringContaining("timed out in completionCache after 1000ms"),
      });
      lifecycle.fail();
      return;
    }
    expect(result).toEqual({ error: undefined, value: "failed" });
    lifecycle.complete(0);
    expect(writeJson).not.toHaveBeenCalled();
    expect(read()).toMatchObject({
      status: "succeeded",
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "finalize:completionCache", status: "failed" }),
        expect.objectContaining({ step: "warning:finalize:completionCache:deadline" }),
      ]),
    });
  },
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("openclaw-finalize-heartbeat-"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLogger();
  setLoggerOverride(null);
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.each(["doctor", "targetConfigConvergence"] as const)(
  "keeps default %s work owned without writing to its child's maintenance database",
  async (phase) => {
    const { lifecycle, stopChildren, read, hold } = finalization(undefined, false, false);
    expect(lifecycle.budget(phase)).toBeUndefined();
    lifecycle.attachLedger();
    const initial = read();
    expect(initial).toBeDefined();
    const heartbeat = vi.spyOn(ledger, "heartbeatUpdateRun");
    const { work, entered, running } = hold(phase);
    await entered;
    try {
      const admitted = read();
      expect(admitted?.origin.driver?.pid).toBe(process.pid);

      await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
      expect(stopChildren).not.toHaveBeenCalled();
      const observed = read();
      expect(observed).toEqual(admitted);
      if (!observed) {
        throw new Error("Finalization lost its update run.");
      }
      expect(inspectUpdateRunAbandonment(observed)).toBeUndefined();
    } finally {
      work.resolve();
      await expect(running).resolves.toBeUndefined();
    }
    heartbeat.mockClear();
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(heartbeat).not.toHaveBeenCalled();
    lifecycle.complete(0);
    expect(read()?.status).toBe("succeeded");
  },
);

it("still cancels owned children when stalled-finalization diagnostics fail", async () => {
  let onStall: (() => void) | undefined;
  vi.spyOn(cliExit, "watchCliExitAfterOutput").mockImplementation((report) => {
    onStall = report;
  });
  const { lifecycle, stopChildren } = finalization(undefined, false, false);
  await withCliProcessScope(async () => {
    lifecycle.complete(0);
    lifecycle.finishRecovery();
  });
  expect(onStall).toBeDefined();
  vi.spyOn(process, "getActiveResourcesInfo").mockImplementation(() => {
    throw new Error("resource inspection failed");
  });
  expect(() => onStall!()).not.toThrow();
  expect(stopChildren).toHaveBeenCalledOnce();
});

it("uses generous state and plugin budgets while preserving explicit operator budgets", () => {
  const defaults = new UpdateFinalizationLifecycle(false, undefined, () => {});
  const explicit = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  for (const [phase, budget] of [
    ["preflight", 300_000],
    ["targetConfigValidation", 300_000],
    ["configSnapshot", 300_000],
    ["plugins", 1_200_000],
    ["completionCache", 300_000],
    ["doctor", undefined],
    ["targetConfigConvergence", undefined],
  ] as const) {
    expect(defaults.budget(phase)).toBe(budget);
    expect(explicit.budget(phase)).toBe(5_000);
  }
});

it("allows plugins to finish beyond their former aggregate deadline", async () => {
  const phase = "plugins";
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  for (const file of [databasePath, `${databasePath}-wal`]) {
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 1024 ** 3);
  }
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw new Error("Finalization exited before the measured work completed");
  });
  const { lifecycle, stopChildren, hold } = finalization(undefined, false, false);
  const { work, entered, running } = hold(phase);
  await entered;
  try {
    await vi.advanceTimersByTimeAsync(600_001);
    expect(stopChildren).not.toHaveBeenCalled();
  } finally {
    work.resolve();
    await running;
  }
  expect(lifecycle.phaseTimings).toContainEqual(
    expect.objectContaining({ phase, outcome: "completed" }),
  );
});

it("renews a long finalization phase and releases its heartbeat after failure", async () => {
  const { lifecycle, read } = finalization(ABANDONED_UPDATE_RUN_MS * 2);
  const initial = read();
  expect(initial).toBeDefined();
  expect(initial.origin.driver?.pid).toBe(process.pid);
  const phase = createDeferredCore();
  const heartbeat = vi.spyOn(ledger, "heartbeatUpdateRun");
  const running = lifecycle.run("plugins", () => phase.promise);
  const settled = expect(running).rejects.toThrow("plugin repair failed");

  await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
  const observed = read();
  expect(observed?.status).toBe("running");
  expect(observed?.updatedAtMs).toBeGreaterThan(initial.updatedAtMs + ABANDONED_UPDATE_RUN_MS);
  phase.reject(new Error("plugin repair failed"));
  await settled;
  expect(heartbeat).toHaveBeenCalled();
  heartbeat.mockClear();
  const finishedPhase = read();
  expect(finishedPhase?.steps).toContainEqual(
    expect.objectContaining({
      step: "finalize:plugins",
      status: "failed",
      failureFacts: [
        { check: "plugins", code: "finalization-failed", message: "plugin repair failed" },
      ],
    }),
  );
  await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
  expect(heartbeat).not.toHaveBeenCalled();
  expect(read()).toEqual(finishedPhase);
  lifecycle.complete(1);
});

it("continues finalization after heartbeat errors and warns once for the run", async () => {
  const { lifecycle, stopChildren, read } = finalization(ABANDONED_UPDATE_RUN_MS * 2);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(ledger, "heartbeatUpdateRun").mockImplementation(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  for (const phase of ["plugins", "completionCache"] as const) {
    const work = createDeferredCore();
    const running = lifecycle.run(phase, () => work.promise);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(stopChildren).not.toHaveBeenCalled();
    work.resolve();
    await expect(running).resolves.toBeUndefined();
  }
  lifecycle.complete(0);
  expect(read()?.status).toBe("succeeded");
  expect(warning).toHaveBeenCalledTimes(1);
  expectMessages(warning, "SQLITE_BUSY");
});

it.each([false, true])(
  "expires Doctor work at its deadline after custody and despite progress=%s",
  async (progress) => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const lifecycle = new UpdateFinalizationLifecycle(true, 1_000, () => {});
    const custodyEntered = createDeferredCore();
    const custodyReady = createDeferredCore();
    const workEntered = createDeferredCore<{
      signal: AbortSignal;
      capture: NonNullable<ReturnType<typeof captureUpdateFinalizationDoctorOutput>>;
    }>();
    const settled = createDeferredCore();
    let finished = false;
    const running = withCliProcessScope(() =>
      lifecycle.run(
        "doctor",
        async ({ signal }) => {
          const capture = captureUpdateFinalizationDoctorOutput("pre-plugin")!;
          capture(Buffer.from("STEP active fixture-validation"), "stderr");
          workEntered.resolve({ signal, capture });
          await settled.promise;
        },
        undefined,
        {
          enter: async () => {
            custodyEntered.resolve();
            await custodyReady.promise;
          },
        },
      ),
    ).then(
      () => {
        finished = true;
        return undefined;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    const beforeCompletion = <T>(admission: Promise<T>) =>
      Promise.race([
        admission,
        running.then((error) => {
          throw error instanceof Error
            ? error
            : new Error("Doctor work completed before fixture admission", { cause: error });
        }),
      ]);
    try {
      await beforeCompletion(custodyEntered.promise);
      // Custody precedes the work deadline; total phase time also includes it.
      await vi.advanceTimersByTimeAsync(3_500);
      expect(finished).toBe(false);
      custodyReady.resolve();
      const { signal, capture } = await beforeCompletion(workEntered.promise);
      await vi.advanceTimersByTimeAsync(999);
      expect(signal.aborted).toBe(false);
      if (progress) {
        capture(Buffer.from("\nPROGRESS fixture-validation"), "stderr");
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(signal.reason.message).toContain("timed out in doctor after 1000ms");
      expect(finished).toBe(false);
      // Reporting must join admitted work after cancellation rather than truncate its duration.
      await vi.advanceTimersByTimeAsync(100);
      settled.resolve();
      expect(await running).toBe(signal.reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(lifecycle.phaseTimings).toEqual([
        { phase: "doctor", startedOffsetMs: 0, durationMs: 4_600, outcome: "failed" },
      ]);
      lifecycle.complete(1);
      expect(writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          stuckPhase: "doctor",
          doctorOutput: expect.objectContaining({
            stderr: expect.objectContaining({
              excerpt: expect.stringContaining(
                progress ? "PROGRESS fixture-validation" : "STEP active fixture-validation",
              ),
            }),
          }),
        }),
      );
    } finally {
      custodyReady.resolve();
      settled.resolve();
      await running;
    }
  },
);
