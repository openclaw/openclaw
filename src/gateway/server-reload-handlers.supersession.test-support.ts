import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activateSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createConfigReloadTestClock } from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";
import {
  createConfigWriteNotification,
  createDirectConfigWriteFixture,
  createHotTailPlan,
  createHotReloadPublication,
  type ReloadTestFactories,
  createValidConfigSnapshot,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import {
  createMockRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";

export function registerGatewaySupersededReloadTests({
  createGatewayReloadHandlers,
  startManagedGatewayConfigReloader,
  refreshContextWindowCache,
  refreshPreparedModelRuntimeSnapshots,
}: ReloadTestFactories & {
  refreshContextWindowCache: Mock<(config: OpenClawConfig) => Promise<void>>;
  refreshPreparedModelRuntimeSnapshots: Mock<
    (config: OpenClawConfig, options?: { catalogMode?: "live" | "static" }) => Promise<void>
  >;
}): void {
  it.each([
    "agent removal",
    "model-neutral edit",
    "same config",
    "invalid watched edit",
    "failed secrets preflight",
  ] as const)("recovers a superseded model build after %s without a restart", async (successor) => {
    const rejectedSuccessor =
      successor === "invalid watched edit" || successor === "failed secrets preflight";
    const { clock, scheduler } = createConfigReloadTestClock();
    const watcher = successor === "invalid watched edit" ? installWatcherMock() : undefined;
    const initialConfig: OpenClawConfig = { agents: { entries: { main: {}, retiring: {} } } };
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
      throw new PreparedModelRuntimePublicationSupersededError("publication replaced");
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
        createConfigWriteNotification(config, `write-${revision}`, revision, "runtime", "source"),
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
  });

  it.each([
    { name: "replaced models with current config", superseded: false, cancelled: true },
    { name: "failed superseded publication", superseded: true, cancelled: false },
  ])("preserves the recovery distinction for a $name", async ({ superseded, cancelled }) => {
    const handlers = createGatewayReloadHandlers({});
    using _ = { [Symbol.dispose]: () => handlers.stopRestartRetries() };
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
    const reload = handlers.applyHotReload(
      buildGatewayReloadPlan(["models.providers.fixture.apiKey"]),
      config,
      createHotReloadPublication(config, () => current),
    );
    const recoveryRequired = !cancelled;
    if (!recoveryRequired) {
      await expect(reload).rejects.toBeInstanceOf(GatewayConfigReloadSupersededError);
    } else {
      await expect(reload).resolves.toBe("applied-restart-required");
    }
    expect(handlers.hasOutstandingGatewayRestart()).toBe(recoveryRequired && !superseded);
  });

  it("reports a failed context tail without restarting the newer config", async () => {
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
    const handlers = createGatewayReloadHandlers({ logReload, requestRecoveryRestart });
    const configA: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/a" } } };
    const reloadA = handlers.applyHotReload(
      createHotTailPlan({
        changedPaths: ["agents.defaults.workspace"],
        hotReasons: ["agents.defaults.workspace"],
      }),
      configA,
      createHotReloadPublication(configA, () => current),
    );
    await entered.promise;
    current = false;
    release.resolve();
    await expect(reloadA).resolves.toBe("applied");
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("reapply the config or restart the Gateway"),
    );
    const configC: OpenClawConfig = { logging: { level: "debug" } };
    await handlers.applyHotReload(
      createHotTailPlan(),
      configC,
      createHotReloadPublication(configC),
    );
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
      createHotReloadPublication({}, () => current),
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
      reason: "config-reload",
      preserveManualStop: true,
      skipUnavailableAccounts: true,
    });
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });
}
