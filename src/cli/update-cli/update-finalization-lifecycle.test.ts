import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

const dirs = createTempDirTracker();

it("records a Doctor refusal before reporting standalone finalization", async () => {
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  const message =
    "Doctor could not enter maintenance. Error: The update parent owns Gateway activation.";
  const privatePath = "/home/example/private-doctor-input";
  await expect(
    lifecycle.run("doctor", async () => {
      throw new UpdateDoctorError(`${message} ${privatePath}`, [
        { check: "doctor", code: "doctor-failed", message },
      ]);
    }),
  ).rejects.toThrow(message);
  lifecycle.fail();
  expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).not.toContain(privatePath);
  closeOpenClawStateDatabaseForTest();
  const run = listUpdateRuns()[0]!;
  expect(run).toMatchObject({
    status: "failed",
    reason: "doctor-failed",
  });
  const report = await prepareUpdateFailureReport({
    attemptId: run.runId,
    recordedRun: run,
    result: { status: "error", mode: "unknown", steps: [], durationMs: 1 },
  });
  expect(report.body).toContain("Reason code: doctor-failed");
  expect(report.body).toContain(`Failed phase finalize:doctor: ${message}`);
  expect(report.body).not.toContain("Failed phase finalize:doctor: exit unknown");
});

it.each([
  "preflight",
  "targetConfigValidation",
  "configSnapshot",
  "doctor",
  "plugins",
  "targetConfigConvergence",
  "completionCache",
] as const)("records the %s failure reason without finishing an inherited run", async (phase) => {
  const inherited = ledger.createUpdateRun({ trigger: "cli" });
  vi.stubEnv(UPDATE_RUN_ID_ENV, inherited.runId);
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  await expect(
    lifecycle.run(phase, async () => {
      throw new Error("phase failed");
    }),
  ).rejects.toThrow("phase failed");
  lifecycle.fail();
  expect(getUpdateRun(inherited.runId)).toMatchObject({
    status: "running",
    reason: `finalize:${phase}`,
  });
  ledger.finishUpdateRun(inherited.runId, { status: "failed", reason: "parent-failure" });
  expect(getUpdateRun(inherited.runId)?.reason).toBe("parent-failure");
});

it("records a returned failed outcome without requiring an exception", async () => {
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  await lifecycle.run(
    "plugins",
    async () => undefined,
    () => ({
      outcome: "failed",
      failureFacts: [{ check: "plugin-update", code: "plugin-update-failed" }],
    }),
  );
  lifecycle.complete(1);
  expect(listUpdateRuns()[0]).toMatchObject({ status: "failed", reason: "plugin-update-failed" });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("openclaw-finalize-heartbeat-"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.each(["doctor", "targetConfigConvergence"] as const)(
  "keeps default %s work owned without writing to its child's maintenance database",
  async (phase) => {
    const stopChildren = vi.fn();
    const lifecycle = new UpdateFinalizationLifecycle(false, undefined, stopChildren);
    expect(lifecycle.budget(phase)).toBeUndefined();
    lifecycle.attachLedger();
    const [initial] = listUpdateRuns();
    if (!initial) {
      throw new Error("Finalization did not create its update run.");
    }
    const work = createDeferredCore();
    const entered = createDeferredCore();
    const timerCount = vi.getTimerCount();
    const running = withCliProcessScope(() =>
      lifecycle.run(phase, () => {
        entered.resolve();
        return work.promise;
      }),
    );
    await entered.promise;
    try {
      const admitted = getUpdateRun(initial.runId);
      expect(admitted?.origin.driver?.pid).toBe(process.pid);

      await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
      expect(stopChildren).not.toHaveBeenCalled();
      const observed = getUpdateRun(initial.runId);
      expect(observed).toEqual(admitted);
      if (!observed) {
        throw new Error("Finalization lost its update run.");
      }
      expect(inspectUpdateRunAbandonment(observed)).toBeUndefined();
    } finally {
      work.resolve();
      await expect(running).resolves.toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(timerCount);
    lifecycle.complete(0);
    expect(getUpdateRun(initial.runId)?.status).toBe("succeeded");
  },
);

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

it("sizes finalization state without blocking the parent on database metadata", async () => {
  const database = resolveOpenClawStateSqlitePath(process.env);
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, "");
  fs.truncateSync(database, 2 * 1024 ** 3);
  const parentStat = vi.spyOn(fs, "statSync");
  const lifecycle = new UpdateFinalizationLifecycle(false, undefined, () => {});
  await lifecycle.run("preflight", async () => undefined);
  expect(lifecycle.budget("preflight")).toBe(2_860_000);
  expect(
    parentStat.mock.calls.filter(([file]) =>
      [database, `${database}-wal`, `${database}-shm`, `${database}-journal`].includes(
        String(file),
      ),
    ),
  ).toEqual([]);
});

it.each([
  ["preflight", 30_001],
  ["targetConfigValidation", 30_001],
  ["configSnapshot", 30_001],
  ["completionCache", 30_001],
  ["plugins", 600_001],
] as const)(
  "allows %s to finish beyond its former aggregate deadline",
  async (phase, elapsedMs) => {
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    for (const file of [databasePath, `${databasePath}-wal`]) {
      fs.writeFileSync(file, "");
      fs.truncateSync(file, 1024 ** 3);
    }
    const stopChildren = vi.fn();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("Finalization exited before the measured work completed");
    });
    const lifecycle = new UpdateFinalizationLifecycle(false, undefined, stopChildren);
    const work = createDeferredCore();
    const entered = createDeferredCore();
    const running = withCliProcessScope(() =>
      lifecycle.run(phase, () => {
        entered.resolve();
        return work.promise;
      }),
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(stopChildren).not.toHaveBeenCalled();
    } finally {
      work.resolve();
      await running;
    }
    if (phase !== "plugins") {
      expect(lifecycle.budget(phase)).toBe(2_860_000);
    }
    expect(lifecycle.phaseTimings).toContainEqual(
      expect.objectContaining({ phase, outcome: "completed" }),
    );
  },
);

it.each([false, true])(
  "renews a long finalization phase and releases its heartbeat (failure=%s)",
  async (fails) => {
    const lifecycle = new UpdateFinalizationLifecycle(false, ABANDONED_UPDATE_RUN_MS * 2, () => {});
    lifecycle.attachLedger();
    const [initial] = listUpdateRuns();
    if (!initial) {
      throw new Error("Finalization did not create its update run.");
    }
    expect(initial.origin.driver?.pid).toBe(process.pid);
    const phase = createDeferredCore();
    const timerCount = vi.getTimerCount();
    const running = lifecycle.run("plugins", () => phase.promise);
    const settled = fails
      ? expect(running).rejects.toThrow("plugin repair failed")
      : expect(running).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
    const observed = getUpdateRun(initial.runId);
    expect(observed?.status).toBe("running");
    expect(observed?.updatedAtMs).toBeGreaterThan(initial.updatedAtMs + ABANDONED_UPDATE_RUN_MS);
    if (fails) {
      phase.reject(new Error("plugin repair failed"));
    } else {
      phase.resolve();
    }
    await settled;
    expect(vi.getTimerCount()).toBe(timerCount);
    const finishedPhase = getUpdateRun(initial.runId);
    if (fails) {
      expect(finishedPhase?.steps).toContainEqual(
        expect.objectContaining({
          step: "finalize:plugins",
          status: "failed",
          failureFacts: [
            { check: "plugins", code: "finalization-failed", message: "plugin repair failed" },
          ],
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(getUpdateRun(initial.runId)).toEqual(finishedPhase);
    lifecycle.complete(fails ? 1 : 0);
  },
);

it("continues finalization after heartbeat errors and warns once for the run", async () => {
  const stopChildren = vi.fn();
  const lifecycle = new UpdateFinalizationLifecycle(
    false,
    ABANDONED_UPDATE_RUN_MS * 2,
    stopChildren,
  );
  lifecycle.attachLedger();
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
  expect(listUpdateRuns()[0]?.status).toBe("succeeded");
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
});
