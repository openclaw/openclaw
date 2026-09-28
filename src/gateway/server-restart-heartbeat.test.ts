import { afterEach, expect, it, vi } from "vitest";
import {
  abortActiveCronTaskRuns,
  waitForActiveCronTaskRuns,
} from "../cron/service/active-run-cancellation.js";
import { createCronServiceState } from "../cron/service/state.js";
import { executeJobCoreWithTimeout } from "../cron/service/timer-job-runner.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllBundleLspRuntimes: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
  stopGmailWatcher: async () => {},
  disposeAllCodeModeRuns: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
});

afterEach(async () => {
  const dispose = setHeartbeatWakeHandler(async () => ({ status: "skipped", reason: "disabled" }));
  try {
    await vi.runAllTimersAsync();
  } finally {
    dispose();
    vi.useRealTimers();
  }
});

it("settles a queued heartbeat monitor before joining its cron run during shutdown", async () => {
  vi.useFakeTimers();
  const heartbeatRunner = startHeartbeatRunner({
    cfg: { agents: { defaults: { heartbeat: { every: "30m" } } } },
    runOnce: async () => ({ status: "skipped", reason: "requests-in-flight" }),
  });
  const state = createCronServiceState({
    // The execution core does not open the scheduler store.
    storePath: "unused-heartbeat-monitor",
    cronEnabled: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    requestHeartbeatAndWait,
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const run = executeJobCoreWithTimeout(state, {
    id: "shutdown-heartbeat-monitor",
    agentId: "main",
    name: "heartbeat-main",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 1_800_000 },
    payload: { kind: "heartbeat" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    state: {},
  });
  let close: Promise<void> | undefined;
  try {
    expect(await waitForActiveCronTaskRuns(0)).toEqual({ drained: false, active: 1 });
    // Main-session handoffs have no abortable cron controller; their wake owner settles them.
    expect(abortActiveCronTaskRuns("Gateway restarting.")).toBe(0);
    const completed = vi.fn<() => void>();
    const deps = createGatewayCloseTestDeps({
      heartbeatRunner,
      cron: {
        stop() {},
        stopAndDrain: async () => {
          await run;
        },
      },
    });
    close = prepareGatewayClose(deps, { reason: "restart", restartExpectedMs: 1_000 })
      .then((preparation) => completeGatewayClose(deps, preparation))
      .then(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toHaveBeenCalledOnce();
    expect(await waitForActiveCronTaskRuns(0)).toEqual({ drained: true, active: 0 });
    expect(await run).toMatchObject({
      status: "skipped",
      error: "heartbeat skipped: handler-unavailable",
    });
  } finally {
    heartbeatRunner.stop();
    await run;
    await close;
  }
});
