import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfigAppliedHash,
  setRuntimeConfigAppliedHash,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import * as restartModule from "../infra/restart.js";
import {
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import type { GatewayRestartRequestOptions } from "./server-reload-contracts.js";
import { beginGatewayReloadLifecycle } from "./server-reload-generation.js";
import { createGatewayRestartPlan } from "./server-reload-handlers.config.test-support.js";
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

const restartPlan = createGatewayRestartPlan();

type CoordinatorOptions = Parameters<typeof createGatewayRestartCoordinator>[0];
const coordinators: ReturnType<typeof createGatewayRestartCoordinator>[] = [];

function createCoordinator(
  {
    scheduler = createTestGatewayScheduler("fake-timers"),
    ...params
  }: Partial<CoordinatorOptions["params"]> = {},
  options: Partial<Omit<CoordinatorOptions, "params">> = {},
) {
  const logReload = { info: vi.fn(), warn: vi.fn() };
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  const coordinator = createGatewayRestartCoordinator({
    params: { logReload, requestRecoveryRestart, ...params, scheduler },
    reloadSignal: options.reloadSignal ?? beginGatewayReloadLifecycle(),
    restartRecoveryAvailable: true,
    getActiveCounts: () => zeroActiveCounts,
    formatActiveDetails: () => [],
    formatDeferredWorkStatus: () => "no active work",
    ...options,
  });
  coordinators.push(coordinator);
  return {
    ...coordinator,
    logReload,
    requestRecoveryRestart,
    request: (prepareRuntimeConfig?: GatewayRestartRequestOptions["prepareRuntimeConfig"]) =>
      coordinator.requestGatewayRestart(restartPlan, {}, { prepareRuntimeConfig }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  getTotalQueueSize.mockReset().mockReturnValue(0);
  restartModule.resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.stopRestartRetries();
  }
  vi.restoreAllMocks();
  restartModule.resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("gateway restart readiness preflight", () => {
  it("publishes only the newest applied revision after accepted restart debt retires", () => {
    const previousHash = getRuntimeConfigAppliedHash();
    try {
      setRuntimeConfigAppliedHash("active");
      let restartAccepted = true;
      const coordinator = createCoordinator({}, { hasAcceptedRestart: () => restartAccepted });
      coordinator.publishAppliedConfigHash("superseded");
      coordinator.publishAppliedConfigHash("latest");
      coordinator.publishDeferredAppliedConfigHash();
      expect(getRuntimeConfigAppliedHash()).toBe("active");

      restartAccepted = false;
      coordinator.publishDeferredAppliedConfigHash();
      expect(getRuntimeConfigAppliedHash()).toBe("latest");

      coordinator.publishAppliedConfigHash("next");
      coordinator.publishDeferredAppliedConfigHash();
      expect(getRuntimeConfigAppliedHash()).toBe("next");
    } finally {
      setRuntimeConfigAppliedHash(previousHash);
    }
  });

  it("distinguishes candidate preparation from an outstanding restart request", () => {
    const coordinator = createCoordinator();
    const lifecycle = coordinator.beginGatewayRestartLifecycle();
    expect(coordinator.hasOutstandingGatewayRestart()).toBe(false);
    lifecycle.settle("committed");
    expect(coordinator.hasOutstandingGatewayRestart()).toBe(false);

    coordinator.pauseGatewayRestartForConfigCandidate();
    expect(coordinator.hasOutstandingGatewayRestart()).toBe(false);

    expect(coordinator.request().status).toBe("accepted");
    expect(coordinator.hasOutstandingGatewayRestart()).toBe(true);
    coordinator.stopRestartRetries();
    expect(coordinator.hasOutstandingGatewayRestart()).toBe(false);
  });

  it.each(["failed", "pending"] as const)(
    "keeps serving while restart preflight is %s",
    async (state) => {
      const pending = state === "pending";
      const assertRestartReady = vi
        .fn<() => Promise<void> | void>()
        .mockRejectedValueOnce(new Error("state schema is noncanonical"))
        .mockResolvedValue(undefined);
      const prepareRuntimeConfig = vi.fn(() =>
        pending ? new Promise<OpenClawConfig>(() => {}) : Promise.resolve({}),
      );
      const coordinator = createCoordinator(pending ? {} : { assertRestartReady });
      const { logReload, requestRecoveryRestart } = coordinator;
      expect(coordinator.request(prepareRuntimeConfig).status).toBe("accepted");
      await vi.advanceTimersByTimeAsync(pending ? 30_000 : 0);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      if (pending) {
        expect(logReload.warn).toHaveBeenLastCalledWith(
          expect.stringMatching(
            /^restart still deferred after \d+ms with restart preparation pending; no active work$/,
          ),
        );
        return;
      }
      expect(assertRestartReady).toHaveBeenCalledOnce();
      expect(prepareRuntimeConfig).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        "gateway restart preflight failed: Error: state schema is noncanonical",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(assertRestartReady).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(logReload.info).not.toHaveBeenCalledWith(
        "all operations and replies completed; restarting gateway now",
      );
      coordinator.request(prepareRuntimeConfig);
      await vi.advanceTimersByTimeAsync(0);
      expect(assertRestartReady).toHaveBeenCalledTimes(2);
      expect(prepareRuntimeConfig).toHaveBeenCalledOnce();
      expect(requestRecoveryRestart).toHaveBeenCalledOnce();
    },
  );

  it("prepares outside the restart-signal fence so lease holders can finish", async () => {
    // A config reload holds the plugin lifecycle lease and needs root admission
    // before it can release it; restart preparation waits for that lease.
    const holderGate = Promise.withResolvers<void>();
    const lease = Promise.withResolvers<void>();
    void holderGate.promise.then(() =>
      runWithGatewayIndependentRootWorkAdmission(async () => {}, "reload:config").then(
        lease.resolve,
      ),
    );
    const prepareRuntimeConfig = vi.fn(async () => {
      holderGate.resolve();
      await lease.promise;
      return {} as OpenClawConfig;
    });
    const coordinator = createCoordinator({ assertRestartReady: vi.fn() });
    const { logReload, requestRecoveryRestart } = coordinator;
    coordinator.request(prepareRuntimeConfig);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(prepareRuntimeConfig).toHaveBeenCalledOnce();
    expect(requestRecoveryRestart).toHaveBeenCalledExactlyOnceWith(
      "config reload: gateway.port",
      undefined,
    );
    expect(logReload.warn).not.toHaveBeenCalledWith(expect.stringContaining("failed"));
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
    const activeCounts = { ...zeroActiveCounts, totalActive: 1, agentRuns: 1 };
    const coordinator = createCoordinator(
      { assertRestartReady: vi.fn(), requestRecoveryRestart: vi.fn() },
      {
        getActiveCounts: () => activeCounts,
        formatDeferredWorkStatus: () => "1 active agent run",
      },
    );

    const prepareRuntimeConfig = async () => ({});
    coordinator.request(prepareRuntimeConfig);
    expect(deferSpy).toHaveBeenCalledOnce();

    capturedHooks?.onTimeout?.(1, 300_000);

    coordinator.request(prepareRuntimeConfig);

    expect(cancel).toHaveBeenCalled();
  });
  it("forces the restart at the deadline when production timeout diagnostics cannot inspect work", async () => {
    const queueSize = getTotalQueueSize.mockReturnValue(1);
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const reloadSignal = beginGatewayReloadLifecycle();
    const tracker = createGatewayActiveWorkTracker({ params: { logReload }, reloadSignal });
    const coordinator = createCoordinator(
      { logReload, requestRecoveryRestart },
      { reloadSignal, ...tracker },
    );
    expect(coordinator.request().status).toBe("accepted");
    queueSize.mockImplementation(() => {
      throw new Error("pending-work store unavailable");
    });
    await vi.advanceTimersByTimeAsync(299_500);
    expect(requestRecoveryRestart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(requestRecoveryRestart).toHaveBeenCalledExactlyOnceWith("config reload: gateway.port", {
      force: true,
      waitMs: 300_000,
      reason: "config reload forced restart",
    });
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "pending work unknown (Error: pending-work store unavailable); forcing restart",
      ),
    );
  });

  it.each(["check error", "timeout"])(
    "cancels live retries after %s when the coordinator stops",
    async (failure) => {
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
      coordinator.request();
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
    },
  );
});
