import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  ABANDONED_UPDATE_RUN_MS,
  UPDATE_RUN_HEARTBEAT_MS,
} from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

const dirs = createTempDirTracker();

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
  "keeps default %s work and heartbeat alive beyond the former deadline",
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
    const timerCount = vi.getTimerCount();
    const running = withCliProcessScope(() => lifecycle.run(phase, () => work.promise));

    await vi.advanceTimersByTimeAsync(240_000);
    expect(stopChildren).not.toHaveBeenCalled();
    expect(getUpdateRun(initial.runId)).toMatchObject({ status: "running" });
    expect(getUpdateRun(initial.runId)?.updatedAtMs).toBeGreaterThan(initial.updatedAtMs);
    work.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(timerCount);
    lifecycle.complete(0);
    expect(getUpdateRun(initial.runId)?.status).toBe("succeeded");
  },
);

it("preserves other phase defaults and explicit operator budgets", () => {
  const defaults = new UpdateFinalizationLifecycle(false, undefined, () => {});
  const explicit = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  for (const [phase, budget] of [
    ["preflight", 30_000],
    ["targetConfigValidation", 30_000],
    ["configSnapshot", 30_000],
    ["plugins", 600_000],
    ["completionCache", 30_000],
    ["doctor", undefined],
    ["targetConfigConvergence", undefined],
  ] as const) {
    expect(defaults.budget(phase)).toBe(budget);
    expect(explicit.budget(phase)).toBe(5_000);
  }
});

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
  for (const phase of ["plugins", "targetConfigConvergence"] as const) {
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
