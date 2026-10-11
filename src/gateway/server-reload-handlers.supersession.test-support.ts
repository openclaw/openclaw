import { describe, expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activateSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createConfigReloadTestClock } from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import {
  GatewayConfigReloadSupersededError,
  type GatewayReloadHandlerParams,
  type ManagedGatewayConfigReloaderHandle,
  type ManagedGatewayConfigReloaderParams,
} from "./server-reload-contracts.js";
import {
  createConfigWriteNotification,
  createDirectConfigWriteFixture,
  createHotTailPlan,
  createValidConfigSnapshot,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import type { createGatewayReloadHandlers as createGatewayReloadHandlersImpl } from "./server-reload-hot.js";
import {
  createMockRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";

export function registerGatewaySupersededReloadTests({
  createGatewayReloadHandlers,
  startManagedGatewayConfigReloader,
  refreshContextWindowCache,
  refreshPreparedModelRuntimeSnapshots,
}: {
  createGatewayReloadHandlers: (
    params: Partial<GatewayReloadHandlerParams>,
  ) => ReturnType<typeof createGatewayReloadHandlersImpl>;
  startManagedGatewayConfigReloader: (
    params: Pick<
      ManagedGatewayConfigReloaderParams,
      "initialConfig" | "readSnapshot" | "subscribeToWrites"
    > &
      Partial<ManagedGatewayConfigReloaderParams>,
  ) => ManagedGatewayConfigReloaderHandle;
  refreshContextWindowCache: Mock<(config: OpenClawConfig) => Promise<void>>;
  refreshPreparedModelRuntimeSnapshots: Mock<
    (config: OpenClawConfig, options?: { catalogMode?: "live" | "static" }) => Promise<void>
  >;
}): void {
  describe("gateway hot reload superseded tail recovery", () => {
    it.each([
      "agent removal",
      "model-neutral edit",
      "same config",
      "invalid watched edit",
      "failed secrets preflight",
    ] as const)(
      "recovers a superseded model build after %s without a restart",
      async (successor) => {
        const rejectedSuccessor =
          successor === "invalid watched edit" || successor === "failed secrets preflight";
        const { clock, scheduler } = createConfigReloadTestClock();
        const watcher = successor === "invalid watched edit" ? installWatcherMock() : undefined;
        const initialConfig: OpenClawConfig = {
          agents: { entries: { main: {}, retiring: {} } },
        };
        const firstConfig: OpenClawConfig = {
          agents: { entries: { main: {}, retiring: {}, added: {} } },
        };
        const nextConfig: OpenClawConfig =
          successor === "agent removal"
            ? { agents: { entries: { main: {}, added: {} } } }
            : successor === "model-neutral edit"
              ? { ...firstConfig, logging: { level: "debug" } }
              : successor === "failed secrets preflight"
                ? { ...firstConfig, logging: { level: "warn" } }
                : firstConfig;
        activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
        const writer = createDirectConfigWriteFixture(initialConfig);
        const entered = createDeferred();
        const release = createDeferred();
        refreshPreparedModelRuntimeSnapshots.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          throw new Error("Agent database resources are closing: retiring/openclaw-agent.sqlite");
        });
        const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
        const logReload = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const reloader = startManagedGatewayConfigReloader({
          scheduler,
          initialConfig,
          readSnapshot: writer.readSnapshot,
          subscribeToWrites: writer.subscribeToWrites,
          activateRuntimeSecrets: createMockRuntimeSecretsActivator(async (config) => {
            if (config.logging?.level === "warn") {
              throw new Error("synthetic successor preflight failed");
            }
            return makePreparedSecretsSnapshot(config);
          }),
          requestRecoveryRestart,
          logReload,
        });
        await reloader.ready;
        const write = (config: OpenClawConfig, revision: number) =>
          publishConfigWrite(
            writer.ref.current!,
            createConfigWriteNotification(
              config,
              `write-${revision}`,
              revision,
              "runtime",
              "source",
            ),
          );
        let first: Promise<RuntimeConfigWriteApplicationStatus> | undefined;
        let next: Promise<RuntimeConfigWriteApplicationStatus> | undefined;
        try {
          first = write(firstConfig, 1);
          const firstWake = clock.wake();
          await awaitGateBeforeSettlement(entered.promise, first, "model build must start");
          expect(reloader.getCommittedRuntimeConfig?.()).toEqual(firstConfig);
          if (watcher) {
            writer.readSnapshot.mockResolvedValueOnce({
              ...createValidConfigSnapshot(firstConfig, "invalid-edit"),
              raw: "{",
              valid: false,
              issues: [{ path: "", message: "synthetic invalid edit" }],
            });
            watcher.emit("change", "/tmp/openclaw.json");
          } else {
            next = write(nextConfig, 2);
          }
          release.resolve();
          await firstWake;
          await clock.wake();
          await expect(first).resolves.toBe("superseded");
          if (rejectedSuccessor) {
            if (watcher) {
              expect(logReload.warn).toHaveBeenCalledWith(
                expect.stringContaining("config reload skipped (invalid config)"),
              );
            } else {
              await expect(next).resolves.toBe("failed");
              expect(logReload.error).toHaveBeenCalledWith(
                expect.stringContaining("synthetic successor preflight failed"),
              );
            }
            expect(refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledOnce();
            expect(reloader.isConfigReloadSettled()).toBe(false);
            expect(requestRecoveryRestart).not.toHaveBeenCalled();
            // Reapplying committed bytes must rebuild the deferred model owners.
            next = write(firstConfig, 3);
            await clock.wake();
          }
          await expect(next).resolves.toBe("applied");
          const appliedConfig = rejectedSuccessor ? firstConfig : nextConfig;
          expect(refreshPreparedModelRuntimeSnapshots).toHaveBeenLastCalledWith(
            appliedConfig,
            expect.anything(),
          );
          expect(refreshPreparedModelRuntimeSnapshots).toHaveBeenCalledTimes(2);
          expect(refreshContextWindowCache).toHaveBeenLastCalledWith(appliedConfig);
          expect(reloader.isConfigReloadSettled()).toBe(true);
          expect(requestRecoveryRestart).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await reloader.stop();
          await Promise.allSettled([first, next]);
          watcher?.restore();
        }
      },
    );

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
        const recoveryRequired = !cancelled && !superseded;
        if (!recoveryRequired) {
          await expect(reload).rejects.toBeInstanceOf(GatewayConfigReloadSupersededError);
        } else {
          await expect(reload).resolves.toBe("applied-restart-required");
        }
        expect(setState).toHaveBeenCalledOnce();
        expect(handlers.hasOutstandingGatewayRestart()).toBe(recoveryRequired);
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
