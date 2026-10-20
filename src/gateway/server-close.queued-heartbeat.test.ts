import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { CliDeps } from "../cli/deps.types.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { waitForActiveCronTaskRuns } from "../cron/service/active-run-cancellation.js";
import { createCronServiceState } from "../cron/service/state.js";
import { executeJobCoreWithTimeout } from "../cron/service/timer-job-runner.js";
import { resolveCronJobsStorePathFromConfigAsync } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createCloseTestDeps } from "./server-close.lifecycle.test-support.js";
import { buildGatewayCronService } from "./server-cron.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => vi.useRealTimers());

it("settles queued heartbeat cron work before joining its shutdown drain", async () => {
  vi.useFakeTimers();
  const stateDir = tempDirs.make("gateway-close-queued-heartbeat-");
  const cfg = { cron: { enabled: false }, agents: { entries: { main: {} } } };
  const scheduler = createTestGatewayScheduler();
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const { cron } = buildGatewayCronService({
    storePath: await resolveCronJobsStorePathFromConfigAsync(cfg, env),
    scheduler,
    cfg,
    deps: {} as CliDeps,
    broadcast: () => {},
    env,
  });
  const runOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
  const runner = startHeartbeatRunner({ cfg, runOnce });
  const queued = createDeferredCore();
  const siblingStarted = createDeferredCore();
  const releaseSibling = createDeferredCore();
  const core = createCronServiceState({
    scheduler,
    cronEnabled: true,
    storePath: path.join(stateDir, "jobs.json"),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    nowMs: () => Date.now(),
    defaultAgentId: "main",
    enqueueSystemEvent: () => {},
    requestHeartbeat: () => {},
    requestHeartbeatAndWait: (wake, lifecycle) =>
      requestHeartbeatAndWait(wake, {
        ...lifecycle,
        onQueued: () => {
          lifecycle.onQueued?.();
          queued.resolve();
        },
      }),
    runIsolatedAgentJob: async () => {
      siblingStarted.resolve();
      await releaseSibling.promise;
      return { status: "ok" };
    },
  });
  const run = (job: Pick<CronJob, "id" | "name" | "payload" | "sessionTarget" | "agentId">) =>
    executeJobCoreWithTimeout(core, makeCronJob(job));
  const sibling = run({
    id: "admitted-sibling",
    name: "admitted sibling",
    payload: { kind: "agentTurn", message: "finish owned work" },
    sessionTarget: "isolated",
  });
  await siblingStarted.promise;
  let heartbeatSettled = false;
  const running = run({
    id: "queued-monitor",
    name: "queued monitor",
    agentId: "main",
    payload: { kind: "heartbeat" },
    sessionTarget: "main",
  }).then((result) => {
    heartbeatSettled = true;
    return result;
  });
  await queued.promise;
  // Fence a real queued wake, not an embedded run already settled by reply cancellation.
  markGatewayRestartDraining();
  await vi.advanceTimersByTimeAsync(0);
  // CLI activity joins precede runner stop; only the executing sibling may remain.
  const heartbeatSettledBeforeClose = heartbeatSettled;
  const beforeClose = await waitForGatewayActiveWork(0);
  const drainEntered = createDeferredCore();
  const stopAndDrain = cron.stopAndDrain!.bind(cron);
  vi.spyOn(cron, "stopAndDrain").mockImplementation(() => {
    drainEntered.resolve();
    return stopAndDrain();
  });
  let closed = false;
  const sharedStateClosed = vi.fn();
  const deps = createCloseTestDeps({
    cron,
    heartbeatRunner: runner,
    clearSecretsRuntimeSnapshot: sharedStateClosed,
  });
  const closing = prepareGatewayClose(deps, {
    reason: "queued heartbeat restart",
    restartExpectedMs: 0,
  })
    .then((preparation) => completeGatewayClose(deps, preparation))
    .then((result) => {
      closed = true;
      return result;
    });
  try {
    await drainEntered.promise;
    expect(heartbeatSettledBeforeClose).toBe(true);
    expect(beforeClose.snapshot.counts.cronRuns).toBe(1);
    // Keep the real 10s grace: queued wakes cannot wait for the later heartbeat stop.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(heartbeatSettled).toBe(true);
    expect(closed).toBe(false);
    expect(sharedStateClosed).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
    await expect(running).resolves.toMatchObject({
      status: "skipped",
      error: "heartbeat skipped: gateway-draining",
    });
    // A cancellation result does not release the admitted sibling's actual work.
    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: false, active: 1 });
    releaseSibling.resolve();
    expect((await closing).warnings).toEqual([]);
    expect(closed).toBe(true);
    expect(sharedStateClosed).toHaveBeenCalledOnce();
    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({ drained: true, active: 0 });
  } finally {
    runner.stop();
    releaseSibling.resolve();
    try {
      await Promise.allSettled([running, sibling, closing]);
    } finally {
      resetGatewayWorkAdmission();
      // Retained notifications belong to the wake queue, not to the retired waiter.
      const dispose = setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
      try {
        await vi.advanceTimersByTimeAsync(250);
      } finally {
        dispose();
      }
    }
  }
});
