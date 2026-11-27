import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { startUpdateRunWatcher, wakeUpdateRunWatcher } from "../gateway/update-run-watcher.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { recordUpdateRunStepAsync } from "./update-run-write.async.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
});

it("retains post-activation advice from a closed tick scope without reopening the update", async () => {
  const stateDir = tempDirs.make("openclaw-update-advice-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const run = createUpdateRun({ trigger: "control-ui" }, options);
  const finished = finishUpdateRun(run.runId, { status: "succeeded" }, options);
  const step = "post-activation doctor inspections";
  recordUpdateRunStep(run.runId, { step, status: "in_progress" }, options);
  expect(getUpdateRun(run.runId, options)?.steps).not.toContainEqual(
    expect.objectContaining({ step }),
  );
  for (const name of [
    step,
    `warning:${step}`,
    `warning:${step}:2`,
    `diagnostic:${step}:2`,
    `finalize:doctor-lint:${step}`,
  ]) {
    recordUpdateRunStep(
      run.runId,
      { step: name, status: "completed", detail: "Inspection receipt." },
      options,
    );
  }
  recordUpdateRunStep(
    run.runId,
    { step: "late-non-advisory", status: "failed", reason: "must-not-change-outcome" },
    options,
  );
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const lifecycle = createGatewayUpdateLifecycle(scheduler);
  const watcher = startUpdateRunWatcher({ lifecycle, broadcast: vi.fn(), log: { warn: vi.fn() } });
  const tick = new AsyncWorkScope();
  const closed = Promise.withResolvers<void>();
  try {
    const job = tick.run(async () => {
      await closed.promise;
      const accepted = wakeUpdateRunWatcher(run.runId, async () => {
        await recordUpdateRunStepAsync(
          run.runId,
          {
            step: `diagnostic:${step}:closed-tick`,
            status: "completed",
            detail: "Closed tick inspection receipt.",
          },
          options,
        );
      });
      expect(accepted).toBe(true);
    });
    await tick.drain();
    closed.resolve();
    await job;
    // The watcher owns the advisory job; stopping it joins that work.
    await watcher.stop();
    expect(getUpdateRun(run.runId, options)?.steps).toContainEqual(
      expect.objectContaining({ detail: "Closed tick inspection receipt." }),
    );
  } finally {
    closed.resolve();
    await watcher.stop();
    await lifecycle.stop();
    await scheduler.stop();
  }
  const retained = getUpdateRun(run.runId, options)!;
  expect(retained).toMatchObject({
    status: "succeeded",
    phase: "finished",
    reason: null,
    finishedAtMs: finished.finishedAtMs,
  });
  expect(retained.steps).not.toContainEqual(expect.objectContaining({ step: "late-non-advisory" }));
  expect(retained.steps.filter(({ detail }) => detail === "Inspection receipt.")).toHaveLength(5);
});

it.each(["completed", "failed"] as const)(
  "retains final postcompletion plugin %s without changing the core outcome",
  (status) => {
    const stateDir = tempDirs.make("openclaw-update-plugin-receipt-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const run = createUpdateRun({ trigger: "control-ui" }, options);
    const finished = finishUpdateRun(run.runId, { status: "succeeded" }, options);
    recordUpdateRunStep(
      run.runId,
      { step: "plugins", status: "in_progress", detail: "Updating plugins…" },
      options,
    );
    expect(getUpdateRun(run.runId, options)?.steps).not.toContainEqual(
      expect.objectContaining({ step: "plugins" }),
    );
    const detail = "Plugin maintenance receipt.";
    recordUpdateRunStep(
      run.runId,
      {
        step: "plugins",
        status,
        startedAtMs: 100,
        endedAtMs: 200,
        detail,
      },
      options,
    );
    const retained = getUpdateRun(run.runId, options)!;
    expect(retained).toMatchObject({
      status: "succeeded",
      phase: "finished",
      reason: null,
      finishedAtMs: finished.finishedAtMs,
    });
    expect(retained.steps).toContainEqual(
      expect.objectContaining({
        step: "plugins",
        status,
        startedAtMs: 100,
        endedAtMs: 200,
        detail,
      }),
    );
  },
);
