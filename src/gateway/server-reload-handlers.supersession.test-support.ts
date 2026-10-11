import { describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import {
  GatewayConfigReloadSupersededError,
  type GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";
import { createHotTailPlan } from "./server-reload-handlers.config.test-support.js";
import type { createGatewayReloadHandlers as createGatewayReloadHandlersImpl } from "./server-reload-hot.js";

export function registerGatewaySupersededReloadTests({
  createGatewayReloadHandlers,
  refreshContextWindowCache,
  refreshPreparedModelRuntimeSnapshots,
}: {
  createGatewayReloadHandlers: (
    params: Partial<GatewayReloadHandlerParams>,
  ) => ReturnType<typeof createGatewayReloadHandlersImpl>;
  refreshContextWindowCache: Mock<(config: OpenClawConfig) => Promise<void>>;
  refreshPreparedModelRuntimeSnapshots: Mock<
    (config: OpenClawConfig, options?: { catalogMode?: "live" | "static" }) => Promise<void>
  >;
}): void {
  describe("gateway hot reload superseded tail recovery", () => {
    it.each([
      { name: "superseded publication", superseded: true, cancelled: true },
      { name: "replaced models with current config", superseded: false, cancelled: true },
      { name: "failed superseded publication", superseded: true, cancelled: false },
      { name: "failed current publication", superseded: false, cancelled: false },
    ])("preserves the recovery distinction for a $name", async ({ superseded, cancelled }) => {
      const setState = vi.fn();
      const handlers = createGatewayReloadHandlers({ setState });
      const config: OpenClawConfig = {
        models: {
          providers: {
            fixture: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-key", models: [] },
          },
        },
      };
      let current = true;
      refreshPreparedModelRuntimeSnapshots.mockImplementationOnce(async () => {
        current = !superseded;
        throw cancelled
          ? new PreparedModelRuntimePublicationSupersededError("publication replaced")
          : new Error("catalog build failed");
      });
      try {
        const reload = handlers.applyHotReload(
          buildGatewayReloadPlan(["models.providers.fixture.apiKey"]),
          config,
          {
            sourceConfig: config,
            isCurrent: () => current,
            publish: async (commit) => await commit(),
          },
        );
        if (cancelled) {
          await expect(reload).rejects.toBeInstanceOf(GatewayConfigReloadSupersededError);
        } else {
          await expect(reload).resolves.toBe("applied-restart-required");
        }
        expect(setState).toHaveBeenCalledOnce();
        expect(handlers.hasOutstandingGatewayRestart()).toBe(!cancelled);
      } finally {
        handlers.stopRestartRetries();
      }
    });

    it("rearms detached stale-tail recovery against an already accepted config", async () => {
      vi.useFakeTimers();
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const prepareRuntimeConfig = vi.fn(async (): Promise<OpenClawConfig> => ({
        logging: { level: "debug" },
      }));
      const handlers = createGatewayReloadHandlers({ requestRecoveryRestart });
      handlers.recordAcceptedRestartTarget({
        runtimeConfig: { logging: { level: "debug" } },
        sourceConfig: { logging: { level: "debug" } },
        prepareRuntimeConfig,
      });
      let current = true;
      refreshContextWindowCache.mockImplementationOnce(async () => {
        current = false;
        throw new Error("detached tail failed");
      });
      const plan = createHotTailPlan({
        changedPaths: ["agents.defaults.workspace"],
        hotReasons: ["agents.defaults.workspace"],
      });

      try {
        await handlers.applyHotReload(
          plan,
          { agents: { defaults: { workspace: "/tmp/a" } } },
          {
            sourceConfig: { agents: { defaults: { workspace: "/tmp/a" } } },
            isCurrent: () => current,
            publish: async (commit) => await commit(),
          },
        );
        await vi.runAllTimersAsync();

        expect(prepareRuntimeConfig).toHaveBeenCalledOnce();
        expect(requestRecoveryRestart).toHaveBeenCalledWith(
          "config reload: hot reload recovery: context window cache reload",
          undefined,
        );
      } finally {
        handlers.stopRestartRetries();
      }
    });

    it("pauses stale-target recovery until a newer valid config is accepted", async () => {
      vi.useFakeTimers();
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const handlers = createGatewayReloadHandlers({ requestRecoveryRestart });
      const configA = { logging: { level: "info" as const } } satisfies OpenClawConfig;
      const configC = { logging: { level: "debug" as const } } satisfies OpenClawConfig;
      const prepareA = vi.fn(async () => configA);
      const prepareC = vi.fn(async () => configC);
      handlers.recordAcceptedRestartTarget({
        runtimeConfig: configA,
        sourceConfig: configA,
        prepareRuntimeConfig: prepareA,
      });
      let current = true;
      let rejectTail: ((error: Error) => void) | undefined;
      refreshContextWindowCache.mockImplementationOnce(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectTail = reject;
          }),
      );
      const plan = createHotTailPlan({
        changedPaths: ["agents.defaults.workspace"],
        hotReasons: ["agents.defaults.workspace"],
      });

      try {
        const staleTail = handlers.applyHotReload(plan, configA, {
          sourceConfig: configA,
          isCurrent: () => current,
          publish: async (commit) => await commit(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(refreshContextWindowCache).toHaveBeenCalledOnce();

        current = false;
        handlers.pauseGatewayRestartForConfigCandidate();
        const acceptedBeforeTailFailure = handlers.acceptRestartConfig(configC);
        expect(acceptedBeforeTailFailure.debt).toBeUndefined();
        rejectTail?.(new Error("stale A tail failed"));
        await staleTail;
        await vi.runAllTimersAsync();

        expect(requestRecoveryRestart).not.toHaveBeenCalled();
        expect(prepareA).not.toHaveBeenCalled();

        const accepted = handlers.publishAcceptedRestartTarget({
          runtimeConfig: configC,
          sourceConfig: configC,
          prepareRuntimeConfig: prepareC,
        });
        expect(accepted.conservativeDebt).toBeDefined();
        if (!accepted.conservativeDebt) {
          throw new Error("expected paused stale-tail recovery debt");
        }
        const restart = handlers.requestGatewayRestart(accepted.conservativeDebt.plan, configC, {
          retainDebtAcrossConfigChanges: accepted.conservativeDebt.retainDebtAcrossConfigChanges,
          debtConfig: configC,
          prepareRuntimeConfig: prepareC,
        });
        restart.settle("committed");
        await vi.runAllTimersAsync();

        expect(requestRecoveryRestart).toHaveBeenCalledOnce();
        expect(prepareC).toHaveBeenCalledOnce();
      } finally {
        handlers.stopRestartRetries();
      }
    });

    it("defers a failed context tail to a newer valid config", async () => {
      const entered = createDeferred();
      const release = createDeferred();
      let current = true;
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      refreshContextWindowCache.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("context tail failed");
      });
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const setState = vi.fn();
      const handlers = createGatewayReloadHandlers({ logReload, requestRecoveryRestart, setState });
      const configA: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/a" } } };
      const reloadA = handlers.applyHotReload(
        createHotTailPlan({
          changedPaths: ["agents.defaults.workspace"],
          hotReasons: ["agents.defaults.workspace"],
        }),
        configA,
        {
          sourceConfig: configA,
          isCurrent: () => current,
          publish: async (commit) => await commit(),
        },
      );
      await entered.promise;
      current = false;
      release.resolve();
      await expect(reloadA).resolves.toBe("applied");
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(logReload.warn).toHaveBeenCalledWith(
        expect.stringContaining("recovery deferred to the newer config"),
      );
      const configC: OpenClawConfig = { logging: { level: "debug" } };
      await handlers.applyHotReload(createHotTailPlan(), configC, {
        sourceConfig: configC,
        isCurrent: () => true,
        publish: async (commit) => await commit(),
      });
      expect(setState).toHaveBeenCalledTimes(2);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
    });

    it("finishes a channel restart after config B revokes A between stop and start", async () => {
      const stopped = createDeferred();
      const releaseStop = createDeferred();
      let current = true;
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const startChannel = vi.fn(async () => new Map());
      const stopChannel = vi.fn(async () => {
        stopped.resolve();
        await releaseStop.promise;
      });
      const handlers = createGatewayReloadHandlers({
        startChannel,
        stopChannel,
        requestRecoveryRestart,
      });
      const reloadA = handlers.applyHotReload(
        createHotTailPlan({ restartChannels: new Set(["discord"]) }),
        {},
        {
          sourceConfig: {},
          isCurrent: () => current,
          publish: async (commit) => await commit(),
        },
      );

      await stopped.promise;
      current = false;
      releaseStop.resolve();
      await reloadA;

      expect(stopChannel).toHaveBeenCalledWith("discord", undefined, {
        manual: false,
        routeHandoff: true,
      });
      expect(startChannel).toHaveBeenCalledWith("discord", undefined, {
        preserveManualStop: true,
        skipUnavailableAccounts: true,
      });
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
    });
  });
}
