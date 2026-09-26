import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import * as restartModule from "../infra/restart.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
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
  restartHeartbeat: false,
  reloadPlugins: false,
  restartChannels: new Set(),
  disposeMcpRuntimes: false,
  noopPaths: [],
} satisfies GatewayReloadPlan;

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
  it("keeps the current lifecycle serving until successor state is restart-ready", async () => {
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const assertRestartReady = vi
      .fn<() => Promise<void> | void>()
      .mockRejectedValueOnce(new Error("state schema is noncanonical"))
      .mockResolvedValue(undefined);
    const prepareRuntimeConfig = vi.fn(async () => ({}) as OpenClawConfig);
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const params = { assertRestartReady, logReload, requestRecoveryRestart };
    const coordinator = createGatewayRestartCoordinator({
      params,
      myGeneration: nextGatewayReloadGeneration(),
      restartRecoveryAvailable: true,
      getActiveCounts: () => zeroActiveCounts,
      formatActiveDetails: () => [],
      formatDeferredWorkStatus: () => "no active work",
    });
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
    const coordinator = createGatewayRestartCoordinator({
      params: { assertRestartReady: vi.fn(), logReload, requestRecoveryRestart: vi.fn() },
      myGeneration: nextGatewayReloadGeneration(),
      restartRecoveryAvailable: true,
      getActiveCounts: () => activeCounts,
      formatActiveDetails: () => [],
      formatDeferredWorkStatus: () => "1 active agent run",
    });

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
    const coordinator = createGatewayRestartCoordinator({
      params: { logReload, requestRecoveryRestart },
      myGeneration,
      restartRecoveryAvailable: true,
      ...tracker,
    });
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
        { force: true, drainBudgetExhausted: true, reason: "config reload forced restart" },
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
      const coordinator = createGatewayRestartCoordinator({
        params: { logReload: { info: vi.fn(), warn: vi.fn() }, requestRecoveryRestart },
        myGeneration: nextGatewayReloadGeneration(),
        restartRecoveryAvailable: true,
        getActiveCounts,
        formatActiveDetails: () => ["1 active agent run"],
        formatDeferredWorkStatus: () => "1 active agent run",
      });
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
