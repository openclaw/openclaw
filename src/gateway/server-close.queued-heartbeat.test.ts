import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { CliDeps } from "../cli/deps.types.js";
import { waitForActiveCronTaskRuns } from "../cron/service/active-run-cancellation.js";
import { createCronServiceState } from "../cron/service/state.js";
import { executeJobCoreWithTimeout } from "../cron/service/timer-job-runner.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";
import { buildGatewayCronService } from "./server-cron.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllCodeModeRuns: async () => {},
  disposeAllBundleLspRuntimes: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
  stopGmailWatcher: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
});

afterEach(() => vi.useRealTimers());

it("settles queued heartbeat cron work before joining its shutdown drain", async () => {
  vi.useFakeTimers();
  const stateDir = tempDirs.make("gateway-close-queued-heartbeat-");
  const cfg = { cron: { enabled: false }, agents: { list: [{ id: "main" }] } };
  const { cron } = buildGatewayCronService({
    cfg,
    deps: {} as CliDeps,
    broadcast: () => {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const runOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
  const runner = startHeartbeatRunner({ cfg, runOnce });
  const queued = createDeferredCore();
  const siblingStarted = createDeferredCore();
  const releaseSibling = createDeferredCore();
  const core = createCronServiceState({
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
  const sibling = executeJobCoreWithTimeout(core, {
    id: "admitted-sibling",
    name: "admitted sibling",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "agentTurn", message: "finish owned work" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    state: {},
  });
  await siblingStarted.promise;
  let heartbeatSettled = false;
  const running = executeJobCoreWithTimeout(core, {
    id: "queued-monitor",
    name: "queued monitor",
    agentId: "main",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "heartbeat" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    state: {},
  }).then((result) => {
    heartbeatSettled = true;
    return result;
  });
  await queued.promise;
  // The real wake is pending at the zero-drain restart admission fence, not
  // an embedded model run that reply cancellation could already settle.
  markGatewayRestartDraining();
  const drainEntered = createDeferredCore();
  const stopAndDrain = cron.stopAndDrain!.bind(cron);
  vi.spyOn(cron, "stopAndDrain").mockImplementation(() => {
    drainEntered.resolve();
    return stopAndDrain();
  });
  let closed = false;
  const sharedStateClosed = vi.fn();
  const deps = createGatewayCloseTestDeps({
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
    // Preserve the real 10s cron drain. A queued wake must not consume it
    // waiting for a heartbeat stop that close has placed after its own join.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(heartbeatSettled).toBe(true);
    expect(closed).toBe(false);
    expect(sharedStateClosed).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
    await expect(running).resolves.toMatchObject({
      status: "skipped",
      error: "heartbeat skipped: handler-unavailable",
    });
    // Cancellation may project a result, but the admitted sibling's actual
    // core must still join before shared resources close.
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
