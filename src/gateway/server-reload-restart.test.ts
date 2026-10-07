import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import * as restartModule from "../infra/restart.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import { nextGatewayReloadGeneration } from "./server-reload-generation.js";
import { createGatewayRestartCoordinator } from "./server-reload-restart.js";

const getTotalQueueSize = vi.hoisted(() => vi.fn(() => 0));
vi.mock("../process/command-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/command-queue.js")>()),
  getTotalQueueSize,
}));

const zeroActiveCounts = {
  queueSize: 0,
  pendingReplies: 0,
  embeddedRuns: 0,
  backgroundExecSessions: 0,
  rootRequests: 0,
  agentRuns: 0,
  acpRuns: 0,
  mediaRuns: 0,
  cronRuns: 0,
  sessionAdmissions: 0,
  sessionMutations: 0,
  chatRuns: 0,
  queuedTurns: 0,
  terminalPersistence: 0,
  terminalSessions: 0,
  lifecycleWrites: 0,
  totalActive: 0,
} satisfies GatewayActiveWorkSnapshot["counts"];

const restartPlan = {
  changedPaths: ["gateway.port"],
  restartGateway: true,
  restartReasons: ["gateway.port"],
  hotReasons: [],
  reloadHooks: false,
  restartGmailWatcher: false,
  restartCron: false,
  reloadPlugins: false,
  restartChannels: new Set(),
  disposeMcpRuntimes: false,
  noopPaths: [],
} satisfies GatewayReloadPlan;

type CoordinatorOptions = Parameters<typeof createGatewayRestartCoordinator>[0];

function createCoordinator(
  {
    scheduler = createTestGatewayScheduler("fake-timers"),
    ...params
  }: Partial<CoordinatorOptions["params"]>,
  options: Partial<Omit<CoordinatorOptions, "params">> = {},
) {
  return createGatewayRestartCoordinator({
    params: { logReload: { info: vi.fn(), warn: vi.fn() }, ...params, scheduler },
    myGeneration: options.myGeneration ?? nextGatewayReloadGeneration(),
    restartRecoveryAvailable: true,
    getActiveCounts: () => zeroActiveCounts,
    formatActiveDetails: () => [],
    formatDeferredWorkStatus: () => "no active work",
    ...options,
  });
}

beforeEach(() => {
  getTotalQueueSize.mockReset().mockReturnValue(0);
  restartModule.resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  restartModule.resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("gateway restart readiness preflight", () => {
  it("catches up one restart retry and permits its emitter to stop the owner", async () => {
    vi.useFakeTimers();
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const requestRecoveryRestart = vi
      .fn<NonNullable<CoordinatorOptions["params"]["requestRecoveryRestart"]>>()
      .mockReturnValueOnce({ status: "failed" })
      .mockImplementationOnce(() => {
        coordinator.stopRestartRetries();
        return { status: "failed" };
      });
    const coordinator = createCoordinator({ scheduler, requestRecoveryRestart });
    try {
      coordinator.requestGatewayRestart(restartPlan, {});
      await clock.advanceBy(60_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
      await clock.advanceBy(60_000);
      expect(requestRecoveryRestart).toHaveBeenCalledTimes(2);
    } finally {
      coordinator.stopRestartRetries();
      await scheduler.stop();
    }
  });

  it.each(["owner", "scheduler"] as const)(
    "does not emit a prepared retry after its %s stops",
    async (boundary) => {
      vi.useFakeTimers();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const preparing = createDeferred();
      const prepared = createDeferred<OpenClawConfig>();
      const requestRecoveryRestart = vi
        .fn<NonNullable<CoordinatorOptions["params"]["requestRecoveryRestart"]>>()
        .mockReturnValue({ status: "failed" });
      const prepareRuntimeConfig = vi
        .fn<() => Promise<OpenClawConfig>>()
        .mockResolvedValueOnce({})
        .mockImplementationOnce(() => {
          preparing.resolve();
          return prepared.promise;
        });
      const coordinator = createCoordinator({ scheduler, requestRecoveryRestart });
      let waking: ReturnType<typeof clock.advanceBy> = undefined;
      try {
        coordinator.requestGatewayRestart(restartPlan, {}, { prepareRuntimeConfig });
        await vi.advanceTimersByTimeAsync(0);
        expect(requestRecoveryRestart).toHaveBeenCalledOnce();
        waking = clock.advanceBy(1_000);
        await preparing.promise;
        // Close after preflight's continuation, before its caller resumes emission.
        const closing = prepared.promise.then(() => {
          if (boundary === "owner") {
            coordinator.stopRestartRetries();
          } else {
            scheduler.beginClose();
          }
        });
        prepared.resolve({});
        await Promise.all([waking, closing]);
        expect(requestRecoveryRestart).toHaveBeenCalledOnce();
      } finally {
        prepared.resolve({});
        coordinator.stopRestartRetries();
        await scheduler.stop();
        await waking;
      }
    },
  );

  it.each(["owner", "scheduler"] as const)(
    "settles a retry parked by suspension when its %s stops",
    async (boundary) => {
      vi.useFakeTimers();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const requestRecoveryRestart = vi
        .fn<NonNullable<CoordinatorOptions["params"]["requestRecoveryRestart"]>>()
        .mockReturnValue({ status: "failed" });
      const coordinator = createCoordinator({ scheduler, requestRecoveryRestart });
      coordinator.requestGatewayRestart(restartPlan, {});
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const waking = clock.advanceBy(1_000);
      try {
        if (boundary === "owner") {
          coordinator.stopRestartRetries();
        } else {
          await scheduler.stop();
        }
        await waking;
        expect(requestRecoveryRestart).toHaveBeenCalledTimes(1);
      } finally {
        suspension?.release();
        coordinator.stopRestartRetries();
        await scheduler.stop();
        await waking;
      }
    },
  );

  it("keeps the current lifecycle serving until successor state is restart-ready", async () => {
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const assertRestartReady = vi
      .fn<() => Promise<void> | void>()
      .mockRejectedValueOnce(new Error("state schema is noncanonical"))
      .mockResolvedValue(undefined);
    const prepareRuntimeConfig = vi.fn(async () => ({}) as OpenClawConfig);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const params = { assertRestartReady, logReload, requestRecoveryRestart };
    const coordinator = createCoordinator(params);
    vi.useFakeTimers();

    try {
      expect(
        coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig, {
          prepareRuntimeConfig,
        }).status,
      ).toBe("accepted");
      await vi.advanceTimersByTimeAsync(0);

      expect(assertRestartReady).toHaveBeenCalledOnce();
      expect(prepareRuntimeConfig).not.toHaveBeenCalled();
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "gateway restart preflight failed: Error: state schema is noncanonical",
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(assertRestartReady).toHaveBeenCalledTimes(2);
      expect(prepareRuntimeConfig).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).toHaveBeenCalledOnce();
    } finally {
      coordinator.stopRestartRetries();
    }
  });

  it("keeps the timed-out deferral cancellable so a later request can supersede it", async () => {
    const cancel = vi.fn();
    const deferSpy = vi.spyOn(restartModule, "deferGatewayRestartUntilIdle");
    let capturedHooks: Parameters<typeof restartModule.deferGatewayRestartUntilIdle>[0]["hooks"];
    deferSpy.mockImplementation(
      (opts: Parameters<typeof restartModule.deferGatewayRestartUntilIdle>[0]) => {
        capturedHooks = opts.hooks;
        return { cancel };
      },
    );
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const activeCounts = { ...zeroActiveCounts, totalActive: 1, agentRuns: 1 };
    const coordinator = createCoordinator(
      { assertRestartReady: vi.fn(), logReload, requestRecoveryRestart: vi.fn() },
      {
        getActiveCounts: () => activeCounts,
        formatDeferredWorkStatus: () => "1 active agent run",
      },
    );

    try {
      coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig, {
        prepareRuntimeConfig: async () => ({}) as OpenClawConfig,
      });
      expect(deferSpy).toHaveBeenCalledOnce();

      capturedHooks?.onTimeout?.(1, 300_000);

      coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig, {
        prepareRuntimeConfig: async () => ({}) as OpenClawConfig,
      });

      expect(cancel).toHaveBeenCalled();
    } finally {
      deferSpy.mockRestore();
      coordinator.stopRestartRetries();
    }
  });
  it("forces the restart at the deadline when production timeout diagnostics cannot inspect work", async () => {
    vi.useFakeTimers();
    const queueSize = getTotalQueueSize.mockReturnValue(1);
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const myGeneration = nextGatewayReloadGeneration();
    const tracker = createGatewayActiveWorkTracker({ params: { logReload }, myGeneration });
    const coordinator = createCoordinator(
      { logReload, requestRecoveryRestart },
      { myGeneration, ...tracker },
    );
    try {
      expect(coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig).status).toBe(
        "accepted",
      );
      queueSize.mockImplementation(() => {
        throw new Error("pending-work store unavailable");
      });
      await vi.advanceTimersByTimeAsync(299_500);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(requestRecoveryRestart).toHaveBeenCalledExactlyOnceWith(
        "config reload: gateway.port",
        { force: true, waitMs: 300_000, reason: "config reload forced restart" },
      );
      expect(logReload.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "pending work unknown (Error: pending-work store unavailable); forcing restart",
        ),
      );
    } finally {
      coordinator.stopRestartRetries();
      queueSize.mockRestore();
    }
  });

  it.each(["check error", "timeout"])(
    "cancels live retries after %s when the coordinator stops",
    async (failure) => {
      vi.useFakeTimers();
      let failedProbe = false;
      const getActiveCounts = vi.fn(() => {
        if (failedProbe) {
          throw new Error("pending-work store unavailable");
        }
        return { ...zeroActiveCounts, totalActive: 1, agentRuns: 1 };
      });
      const requestRecoveryRestart = vi.fn(() => {
        throw new Error("restart emission rejected");
      });
      const coordinator = createCoordinator(
        { requestRecoveryRestart },
        {
          getActiveCounts,
          formatActiveDetails: () => ["1 active agent run"],
          formatDeferredWorkStatus: () => "1 active agent run",
        },
      );
      try {
        coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig);
        failedProbe = failure === "check error";
        await vi.advanceTimersByTimeAsync(failedProbe ? 500 : 300_000);
        if (failedProbe) {
          expect(requestRecoveryRestart).not.toHaveBeenCalled();
        } else {
          expect(requestRecoveryRestart).toHaveBeenCalledOnce();
        }
        coordinator.stopRestartRetries();
        const reads = getActiveCounts.mock.calls.length;
        const emissions = requestRecoveryRestart.mock.calls.length;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(getActiveCounts).toHaveBeenCalledTimes(reads);
        expect(requestRecoveryRestart).toHaveBeenCalledTimes(emissions);
      } finally {
        coordinator.stopRestartRetries();
      }
    },
  );
});
