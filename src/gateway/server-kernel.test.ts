import fs from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import * as deviceIdentity from "../infra/device-identity-async.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import type { GatewayHostLifecycle, GatewayServer } from "./server-public.js";
import { createMaintenanceHandles } from "./server-runtime-services.test-harness.js";
import { expectCoreAgentDatabaseReadiness } from "./server-startup-readiness.test-support.js";
import { withPreparedSessionEventRow } from "./session-event-prepared-row.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

describe("createGatewayKernel", () => {
  it.each([false, true])(
    "starts recovered channels only before close (closing=%s)",
    async (closing) => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: "gateway-kernel-breaker-recovery-close",
        env: {
          ...KERNEL_TEST_ENV,
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
      });
      const originalPluginRegistry = captureActivePluginRegistrySnapshot();
      const started = createDeferred();
      const startAccount = vi.fn<
        NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>
      >(async (ctx) => {
        started.resolve();
        await waitForAbortSignal(ctx.abortSignal);
      });
      const channelPlugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "telegram",
          config: {
            listAccountIds: (config) => Object.keys(config.channels?.telegram?.accounts ?? {}),
            resolveAccount: (config, accountId) =>
              config.channels?.telegram?.accounts?.[accountId ?? "default"] ?? {},
            isConfigured: (account) =>
              typeof (account as { botToken?: unknown }).botToken === "string",
          },
        }),
        gateway: { startAccount },
      };
      const registry = createTestRegistry([
        {
          pluginId: channelPlugin.id,
          plugin: channelPlugin,
          source: "gateway-kernel-test",
        },
      ]);
      registry.plugins.push(
        createPluginRecord({
          id: channelPlugin.id,
          source: "gateway-kernel-test",
          origin: "bundled",
          enabled: true,
          configSchema: false,
        }),
      );
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      try {
        stageActivePluginRegistry(registry, null, "default");
        const token = "gateway-kernel-breaker-recovery-token";
        await state.writeConfig({
          gateway: {
            auth: { mode: "token", token },
            controlUi: { enabled: false },
            port,
          },
          channels: {
            telegram: {
              accounts: {
                default: { botToken: "telegram-breaker-recovery-token" },
              },
            },
          },
        });
        state.applyEnv();
        kernel = await createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          channelAutostartSuppression: {
            reason: "crash-loop-breaker",
            message: "safe mode",
          },
          controlUiEnabled: false,
          sidecarStartup: "defer",
          tryRecoverChannelAutostartSuppression: async () => undefined,
        });

        await expect(kernel.channelManager.recoverAutostartSuppression()).resolves.toBeUndefined();
        expect(startAccount).not.toHaveBeenCalled();

        if (closing) {
          await kernel.prepareClose();
        }
        kernel.releaseStartupAccountStarts();
        await (closing ? nextTurn() : started.promise);

        expect(startAccount).toHaveBeenCalledTimes(closing ? 0 : 1);
        expect(kernel.channelManager.isAutoRestartScheduled("telegram", "default")).toBe(false);
      } finally {
        try {
          await kernel?.closeOnStartupFailure();
        } finally {
          restoreActivePluginRegistrySnapshot(originalPluginRegistry);
          await state.cleanup();
        }
      }
    },
  );

  it.for(["direct", "public"] as const)(
    "fences hosted authority and joins shutdown owners during %s close",
    async (entry, { signal }) => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: `gateway-kernel-${entry}-close-readiness`,
        env: { ...KERNEL_TEST_ENV },
      });
      const token = "gateway-kernel-close-readiness-token";
      const bootId = `gateway-kernel-${entry}-close`;
      const configReloaderStop = createDeferred();
      const recoveryStop = createDeferred();
      const updateCheckStopped = createDeferred();
      const periodicStopped = createDeferred();
      const nativePreparation = createDeferred();
      const preparationStarted = createDeferred();
      const publicationPreparation = createDeferred();
      const publicationStarted = createDeferred();
      const publicationDrainEntered = createDeferred();
      const acceptRequest = vi.fn();
      const hostLifecycle: GatewayHostLifecycle = {
        externalRestart: { isCurrent: () => true },
        async request(_action, assertCaller) {
          assertCaller();
          preparationStarted.resolve();
          await nativePreparation.promise;
          assertCaller();
          acceptRequest();
          return { ok: true, value: { outcome: "scheduled" } };
        },
      };
      const reloadSettled = vi.fn(() => {});
      const recoverySettled = vi.fn(() => {});
      const updateSettled = vi.fn(() => {});
      const reloadWork = configReloaderStop.promise.then(reloadSettled);
      const recoveryWork = recoveryStop.promise.then(recoverySettled);
      const updateWork = updateCheckStopped.promise.then(updateSettled);
      const release = () => {
        configReloaderStop.resolve();
        recoveryStop.resolve();
        updateCheckStopped.resolve();
        periodicStopped.resolve();
        nativePreparation.resolve();
        publicationPreparation.resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let server: GatewayServer | undefined;
      let closing: Promise<void> | undefined;
      let pendingStop: Promise<void> | undefined;
      let pendingPublication: Promise<void> | undefined;
      try {
        await state.writeConfig({
          gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
        });
        state.applyEnv();
        const options = {
          bootId,
          auth: { mode: "token" as const, token },
          bind: "loopback" as const,
          controlUiEnabled: false,
          sidecarStartup: "defer" as const,
          hostLifecycle,
        };
        if (entry === "public") {
          const { startGatewayServerCore } = await import("./server-start.js");
          const createKernel = createGatewayKernel;
          // Capture public startup's real owner without retaining the spy through shutdown.
          const factory = vi
            .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
            .mockImplementation(async (...args) => {
              kernel = await createKernel(...args);
              return kernel;
            });
          try {
            server = await startGatewayServerCore(port, options);
          } finally {
            factory.mockRestore();
          }
          await server.startupSettled;
        } else {
          kernel = await createGatewayKernel(port, options);
          kernel.kernel.unlockStartupMethods();
          kernel.kernel.markSidecarsReady();
          kernel.kernel.setDispatchReady(true);
        }
        if (!kernel) {
          throw new Error("Expected the real Gateway kernel to be captured");
        }
        const projection = getSessionRowProjection(kernel.gatewayRequestContext);
        if (!projection) {
          throw new Error("Expected the real session row projection");
        }
        const projectionDispose = vi.spyOn(projection, "dispose");
        const prepareRows = projection.withPreparedExactRows.bind(projection);
        vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(
          async (queries, consume, prepareOptions) => {
            publicationStarted.resolve();
            await publicationPreparation.promise;
            return prepareRows(queries, consume, prepareOptions);
          },
        );
        const publish = vi.fn();
        pendingPublication = withPreparedSessionEventRow(
          projection,
          "agent:main:shutdown-publication",
          "main",
          publish,
        );
        await publicationStarted.promise;
        const drainPublications = kernel.shutdownRuntime.drainSessionEventPublications;
        vi.spyOn(kernel.shutdownRuntime, "drainSessionEventPublications").mockImplementation(
          async (owner) => {
            const draining = drainPublications(owner);
            publicationDrainEntered.resolve();
            await draining;
          },
        );
        const { getStartup, getReadiness } = kernel.createHttpTransportOptions();
        expect(getStartup()).toMatchObject({ ok: true, status: "started" });
        expect(getReadiness()).toMatchObject({ ready: true, failing: [] });
        const reader = {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "web",
              mode: "webchat",
            },
            role: "operator",
            scopes: ["operator.read"],
          },
          authenticatedUserProfile: {
            profileId: ensureProfileForEmail("mention-reader@example.test").id,
            displayName: "Reader",
            hasAvatar: false,
            updatedAt: 1,
          },
        } satisfies GatewayClient;
        await kernel.gatewayRequestContext.mentionInbox?.listAsync(reader, (result) => {
          expect(result).toMatchObject({
            ok: true,
            value: { gatewayInstanceId: bootId, items: [] },
          });
        });
        const boundHost = kernel.gatewayRequestContext.hostLifecycle!;
        // Handoff consumption compares the private owner, not a copied predicate.
        expect(boundHost.externalRestart).toBe(hostLifecycle.externalRestart);
        pendingStop = expect(boundHost.request("stop", () => {})).rejects.toThrow(
          "closed instance",
        );
        await preparationStarted.promise;

        const closeFirstStop = vi.fn(async () => {});
        kernel.kernel.swapDiscovery({ update: async () => {}, stop: closeFirstStop });
        const reloadStop = vi
          .spyOn(kernel.runtimeState.configReloader, "stop")
          .mockReturnValue(reloadWork);
        const stopRecovery = vi.fn(() => recoveryWork);
        kernel.kernel.setScheduledServiceHandles({
          heartbeatRunner: kernel.runtimeState.heartbeatRunner,
          stopDeliveryRecovery: stopRecovery,
        });
        const stopUpdateCheck = vi
          .spyOn(kernel.runtimeState, "stopGatewayUpdateCheck")
          .mockReturnValue(updateWork);
        const terminalDispose = vi.spyOn(kernel.terminalSessions, "disposeAll");
        const gatewayStop = vi.spyOn(kernel.shutdownRuntime, "runGlobalGatewayStopSafely");
        const maintenance = createMaintenanceHandles();
        maintenance.stopPeriodicTasks.mockReturnValue(periodicStopped.promise);
        kernel.kernel.setMaintenanceHandles(maintenance);
        const invalidateCron = vi.spyOn(kernel.cronReconciliation, "invalidate");
        const startMaintenance = vi.fn(() => {});
        kernel.scheduler.schedule({
          id: "test:post-ready-maintenance",
          delayMs: 0,
          run: startMaintenance,
        });
        closing = server
          ? server.close({ reason: "close ordering test" })
          : kernel.closeOnStartupFailure();

        expect(getStartup()).toMatchObject({ ok: false, status: "draining" });
        expect(getReadiness()).toMatchObject({ ready: false, failing: ["gateway-draining"] });
        await kernel.gatewayRequestContext.mentionInbox?.listAsync(reader, (result) => {
          expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
        });
        nativePreparation.resolve();
        await pendingStop;
        await expect(boundHost.request("start", () => {})).rejects.toThrow("closed instance");
        expect(acceptRequest).not.toHaveBeenCalled();
        expect(invalidateCron).toHaveBeenCalledOnce();
        await nextTurn();
        expect(startMaintenance).not.toHaveBeenCalled();
        expect(reloadStop).toHaveBeenCalledOnce();
        expect(terminalDispose).not.toHaveBeenCalled();
        expect(gatewayStop).not.toHaveBeenCalled();
        configReloaderStop.resolve();
        await nextTurn();
        expect(reloadSettled).toHaveBeenCalledOnce();
        if (server) {
          // Finishing reload alone must not bypass the other admitted producer.
          expect(terminalDispose).not.toHaveBeenCalled();
          expect(gatewayStop).not.toHaveBeenCalled();
        }
        recoveryStop.resolve();
        await nextTurn();
        expect(stopUpdateCheck).toHaveBeenCalled();
        expect(closeFirstStop).not.toHaveBeenCalled();
        updateCheckStopped.resolve();
        await nextTurn();
        periodicStopped.resolve();
        await Promise.race([publicationDrainEntered.promise, closing]);
        expect(projectionDispose).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        publicationPreparation.resolve();
        await pendingPublication;
        await closing;
        expect(publish).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledBefore(projectionDispose);
        expect(projectionDispose).toHaveBeenCalledOnce();
        expect(closeFirstStop).toHaveBeenCalledOnce();
        expect(kernel.runtimeState.discovery).toBeNull();
        if (server) {
          expect(terminalDispose).toHaveBeenCalledOnce();
          expect(gatewayStop).toHaveBeenCalledOnce();
          for (const settled of [reloadSettled, recoverySettled, updateSettled]) {
            expect(settled).toHaveBeenCalledBefore(terminalDispose);
            expect(settled).toHaveBeenCalledBefore(gatewayStop);
          }
        }
      } finally {
        release();
        try {
          await Promise.all([closing, pendingPublication, reloadWork, recoveryWork, updateWork]);
        } finally {
          try {
            await (server?.close() ?? kernel?.closeOnStartupFailure());
            await pendingStop;
          } finally {
            vi.restoreAllMocks();
            signal.removeEventListener("abort", release);
            await state.cleanup();
          }
        }
      }
    },
  );

  it("keeps startup readiness and sidecar shutdown at their lifecycle boundaries", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-deferred-readiness",
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      },
    });
    const token = "gateway-kernel-deferred-readiness-token";
    const openKernel = () =>
      createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, worker: {} },
        },
      });
      state.applyEnv();
      kernel = await openKernel();
      const activeKernel = kernel;

      const client = createSyntheticPluginRuntimeClient({
        scopes: [...CLI_DEFAULT_OPERATOR_SCOPES],
      });
      const dispatchOptions = {
        client,
        context: kernel.gatewayRequestContext,
        methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
      };
      const runId = "deferred-readiness-chat";
      const chatParams = {
        sessionKey: "agent:main:deferred-readiness",
        message: "readiness truth",
        idempotencyKey: runId,
      };

      const getReadiness = kernel.createHttpTransportOptions().getReadiness;
      expect(getReadiness()).toMatchObject({
        ready: false,
        failing: ["startup-sidecars"],
      });
      await expect(
        dispatchGatewayRequestInProcess("chat.send", chatParams, dispatchOptions),
      ).rejects.toThrow("chat.send unavailable during gateway startup");

      kernel.dedupe.set(`chat:${runId}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok" },
      });
      kernel.kernel.unlockStartupMethods();
      kernel.kernel.markSidecarsReady();

      expect(getReadiness()).toMatchObject({
        ready: false,
        failing: ["startup-sidecars"],
      });
      kernel.kernel.setDispatchReady(true);
      expectCoreAgentDatabaseReadiness(getReadiness, state);
      await expect(
        dispatchGatewayRequestInProcess("chat.send", chatParams, dispatchOptions),
      ).resolves.toEqual({ runId, status: "ok" });

      const { promise: firstStop, resolve: releaseFirstStop } = createDeferred();
      const reentrantSidecar = { stop: vi.fn(async () => {}) };
      let reentrantStop!: Promise<void>;
      const lifetimeSidecar = {
        stop: vi.fn<() => Promise<void>>().mockImplementationOnce(() => {
          activeKernel.registerGatewayLifetimeSidecars(lifetimeSidecar, reentrantSidecar);
          reentrantStop = activeKernel.stopRegisteredGatewayLifetimeSidecars();
          return firstStop;
        }),
      };
      lifetimeSidecar.stop.mockResolvedValue(undefined);
      const trailingSidecar = vi.fn(async () => {});
      kernel.registerGatewayLifetimeSidecars(lifetimeSidecar, { stop: trailingSidecar });

      const { promise: firstPostReadyStop, resolve: releasePostReadyStop } = createDeferred();
      const postReadySidecar = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(() => firstPostReadyStop)
        .mockResolvedValue(undefined);
      kernel.registerPostReadySidecars({ stop: postReadySidecar });

      const connectionStopEntered = createDeferred();
      const releaseConnectionStop = createDeferred();
      const releaseLateConnectionStop = createDeferred();
      const connectionSidecar = {
        stop: vi
          .fn<() => Promise<void>>()
          .mockImplementationOnce(async () => {
            connectionStopEntered.resolve();
            await releaseConnectionStop.promise;
          })
          .mockResolvedValue(undefined),
      };
      kernel.registerConnectionDependentSidecars(connectionSidecar);
      const closeTransport = vi.fn(() => releaseConnection());
      const releaseConnection = kernel.connectionWork.registerConnection(closeTransport);
      const closePreludeReached = vi.spyOn(kernel.watchNodeHttpRuntime, "close");
      const closing = kernel.closeOnStartupFailure();
      void closing.catch(() => undefined);
      await connectionStopEntered.promise;
      const lateConnectionSidecar = { stop: vi.fn(() => releaseLateConnectionStop.promise) };
      kernel.registerConnectionDependentSidecars(lateConnectionSidecar);
      const lateGeneralSidecar = { stop: vi.fn(async () => {}) };
      const latePostReadySidecar = { stop: vi.fn(async () => {}) };
      kernel.registerGatewayLifetimeSidecars(lateGeneralSidecar);
      kernel.registerPostReadySidecars(latePostReadySidecar);
      expect(closeTransport).not.toHaveBeenCalled();
      releaseConnectionStop.resolve();
      await vi.waitFor(() => expect(lateConnectionSidecar.stop).toHaveBeenCalledOnce());
      expect(closeTransport).not.toHaveBeenCalled();
      expect(lifetimeSidecar.stop).not.toHaveBeenCalled();
      expect(lateGeneralSidecar.stop).not.toHaveBeenCalled();
      expect(latePostReadySidecar.stop).not.toHaveBeenCalled();
      releaseLateConnectionStop.resolve();
      await vi.waitFor(() => {
        expect(lifetimeSidecar.stop).toHaveBeenCalledOnce();
      });
      expect(closeTransport).toHaveBeenCalledOnce();
      expect(connectionSidecar.stop).toHaveBeenCalledOnce();
      expect(() => kernel?.registerConnectionDependentSidecars(lateConnectionSidecar)).toThrow(
        "cannot publish a Gateway sidecar after shutdown sealed its owner",
      );
      const lateSidecar = { stop: vi.fn(async () => {}) };
      kernel.registerGatewayLifetimeSidecars(lifetimeSidecar, lateSidecar);
      const lateStop = kernel.stopRegisteredGatewayLifetimeSidecars();
      releaseFirstStop();

      await expect(reentrantStop).resolves.toBeUndefined();
      await expect(lateStop).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(postReadySidecar).toHaveBeenCalledOnce();
      });
      const { promise: lateLifetimeStop, resolve: releaseLateLifetimeStop } = createDeferred();
      const lateLifetimeSidecar = { stop: vi.fn(() => lateLifetimeStop) };
      kernel.registerGatewayLifetimeSidecars(lateLifetimeSidecar);
      let closeSettled = false;
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      releasePostReadyStop();
      await vi.waitFor(() => {
        expect(closePreludeReached).toHaveBeenCalledOnce();
      });
      expect(closeSettled).toBe(false);
      const duringSealSidecar = { stop: vi.fn(async () => {}) };
      kernel.registerGatewayLifetimeSidecars(duringSealSidecar);
      releaseLateLifetimeStop();
      await expect(closing).resolves.toBeUndefined();
      closePreludeReached.mockRestore();
      expect(lifetimeSidecar.stop).toHaveBeenCalledOnce();
      expect(trailingSidecar).toHaveBeenCalledOnce();
      expect(lateGeneralSidecar.stop).toHaveBeenCalledOnce();
      expect(latePostReadySidecar.stop).toHaveBeenCalledOnce();
      expect(reentrantSidecar.stop).toHaveBeenCalledOnce();
      expect(lateSidecar.stop).toHaveBeenCalledOnce();
      expect(duringSealSidecar.stop).toHaveBeenCalledOnce();
      expect(postReadySidecar).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([]);
      expect(kernel.runtimeState.postReadySidecars.snapshot()).toEqual([]);

      const postSealSidecar = { stop: vi.fn(async () => {}) };
      expect(() => activeKernel.registerGatewayLifetimeSidecars(postSealSidecar)).toThrow(
        "cannot publish a Gateway sidecar after shutdown sealed its owner",
      );
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([]);
      expect(postSealSidecar.stop).not.toHaveBeenCalled();

      const persistentError = new Error("persistent sidecar cleanup failed");
      const persistentStop = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(persistentError)
        .mockResolvedValue(undefined);
      const persistentSidecar = { stop: persistentStop };
      const successfulPeer = { stop: vi.fn(async () => {}) };
      kernel = await openKernel();
      kernel.registerGatewayLifetimeSidecars(persistentSidecar, successfulPeer);

      await expect(kernel.closeOnStartupFailure()).rejects.toMatchObject({
        errors: [
          {
            message:
              "shutdown step failed (gateway lifetime sidecars): persistent sidecar cleanup failed",
            cause: persistentError,
          },
          {
            message:
              "shutdown step failed (late sidecar cleanup): persistent sidecar cleanup failed",
            cause: persistentError,
          },
        ],
      });
      expect(persistentStop).toHaveBeenCalledOnce();
      expect(successfulPeer.stop).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([persistentSidecar]);

      await expect(kernel.closeOnStartupFailure()).resolves.toBeUndefined();
      expect(persistentStop).toHaveBeenCalledTimes(2);
      expect(successfulPeer.stop).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([]);
    } finally {
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        await state.cleanup();
      }
    }
  });

  it("dispatches without a transport when optional chat identity bootstrap fails", async ({
    signal,
  }) => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-no-transport",
      env: {
        OPENCLAW_DIAGNOSTICS: "1",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: undefined,
        ...KERNEL_TEST_ENV,
      },
    });
    const originalPluginRegistry = captureActivePluginRegistrySnapshot();
    const inspectAccount = vi.fn(() => ({ enabled: true, configured: true }));
    const capturedRegistryCleanup = vi.fn();
    const ambientPlugin = createChannelTestPluginBase({
      id: "telegram",
      config: { inspectAccount },
    });
    const ambientRegistry = createTestRegistry([
      {
        pluginId: ambientPlugin.id,
        plugin: ambientPlugin,
        source: "gateway-kernel-test",
      },
    ]);
    ambientRegistry.plugins.push(
      createPluginRecord({
        id: ambientPlugin.id,
        source: "gateway-kernel-test",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
    );
    ambientRegistry.runtimeLifecycles.push({
      pluginId: ambientPlugin.id,
      pluginName: ambientPlugin.meta.label,
      lifecycle: {
        id: "gateway-kernel-test-cleanup",
        cleanup: capturedRegistryCleanup,
      },
      source: "gateway-kernel-test",
    });
    let capturedLoadedPluginRegistry:
      | ReturnType<typeof captureActivePluginRegistrySnapshot>
      | undefined;
    let prematureCleanupCalls: number | undefined;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    const loadIdentity = vi
      .spyOn(deviceIdentity, "loadOrCreateProcessDeviceIdentityAsync")
      .mockRejectedValueOnce(new Error("synthetic identity read failure"));
    try {
      stageActivePluginRegistry(ambientRegistry, null, "default");
      capturedLoadedPluginRegistry = captureActivePluginRegistrySnapshot();
      const timelinePath = state.path("kernel-startup.jsonl");
      state.envVars.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
      const token = "gateway-kernel-no-transport-token";
      await state.writeConfig({
        gateway: {
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          port,
        },
      });
      state.applyEnv();
      stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");

      kernel = await createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(loadIdentity).toHaveBeenCalledOnce();
      expect(kernel.transportBridge.current()).toBeUndefined();
      await expect(kernel.transportBridge.ensureSandboxHostPort()).rejects.toThrow(
        "Gateway listener must start before the sandbox host",
      );

      kernel.kernel.setDispatchReady(true);
      const client = createSyntheticPluginRuntimeClient({
        scopes: [...CLI_DEFAULT_OPERATOR_SCOPES],
      });
      await expect(
        dispatchGatewayRequestInProcess(
          "health",
          {},
          {
            client,
            context: kernel.gatewayRequestContext,
            methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
          },
        ),
      ).resolves.toEqual(expect.objectContaining({ ok: true }));

      const idempotencyKey = "kernel-factory-agent";
      kernel.dedupe.set(`agent:${idempotencyKey}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId: "kernel-run", status: "ok", summary: "cached" },
      });
      await expect(
        kernel.gatewayInstanceRuntime.recovery.dispatchAgent({
          message: "kernel factory proof",
          idempotencyKey,
        }),
      ).resolves.toEqual({ runId: "kernel-run", status: "ok", summary: "cached" });
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      flushDiagnosticsTimeline();
      const measureNames = (await fs.readFile(timelinePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === "span.start" && event.phase === "startup")
        .map((event) => {
          const attributes = event.attributes as { traceName?: string } | undefined;
          return attributes?.traceName ?? event.name;
        });
      expect(measureNames).toEqual([
        "config.snapshot.read",
        "config.snapshot.read.file",
        "config.snapshot.read.hash",
        "config.snapshot.read.parse",
        "config.snapshot.read.includes",
        "config.snapshot.read.env",
        "config.snapshot.read.validate",
        "config.snapshot.read.materialize",
        "config.snapshot.read.observe",
        "plugins.metadata.scan",
        "plugins.metadata.freeze",
        "state.ownership",
        "state.runtime-imports",
        "state.schema-preflight",
        "runtime.network-imports",
        "runtime.network-bootstrap",
        "config.runtime-imports",
        "config.snapshot",
        "config.auth",
        "config.auth.snapshot-validate",
        "config.auth.runtime-overrides",
        "config.auth.startup-overrides",
        "config.auth.secret-surface",
        "config.auth.secret-preflight",
        "config.auth.preflight-override",
        "config.auth.ensure",
        "config.auth.runtime-startup-overrides",
        "config.auth.secrets-activate",
        "agents.github-profile-cleanup",
        "plugins.bootstrap-imports",
        "cron.store-path",
        "plugins.bootstrap",
        "gateway.kernel-state",
        "node-desktop.runtime-import",
        "host-desktop.runtime-import",
        "computer.runtime-import",
        "device-identity",
        "device-pairing",
        "runtime.config",
        "control-ui.root",
        "terminal.launch-import",
        "gateway.wizard-imports",
        "tls.runtime",
        "gateway.channel-manager-import",
        "runtime.state",
        "gateway.shutdown-runtime-import",
        "gateway.lifecycle",
        "gateway.core-runtime",
        "runtime.post-early-imports",
        "runtime.subscriptions",
        "runtime.services",
        "gateway.handlers",
        "runtime.early",
        "runtime.early.discovery",
        "gateway.request-runtime",
        "gateway.chat-metadata-lifecycle",
        "gateway.config-revision-key",
        "gateway.request-context",
        "sessions.projection",
        "gateway.instance-runtime-import",
        "gateway.owner-profile",
        "sessions.materialize",
        "gateway.lifetime-sidecars",
      ]);
    } finally {
      loadIdentity.mockRestore();
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        try {
          flushDiagnosticsTimeline();
          if (capturedLoadedPluginRegistry) {
            restoreActivePluginRegistrySnapshot(capturedLoadedPluginRegistry);
          }
          prematureCleanupCalls = capturedRegistryCleanup.mock.calls.length;
          restoreActivePluginRegistrySnapshot(originalPluginRegistry);
          await waitForPluginRegistryRetirement(ambientRegistry);
        } finally {
          await state.cleanup();
        }
      }
    }
    expect(prematureCleanupCalls).toBe(0);
    await withinTest(waitForPluginRegistryRetirement(ambientRegistry), signal);
    expect(capturedRegistryCleanup).toHaveBeenCalledOnce();
    expect(inspectAccount).not.toHaveBeenCalled();
  });

  it("runs kernel teardown when required TLS material is unavailable", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-tls-failure",
      env: { ...KERNEL_TEST_ENV },
    });
    const token = "gateway-kernel-tls-failure-token";
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        port,
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: state.path("missing-cert.pem"),
          keyPath: state.path("missing-key.pem"),
        },
      },
    });
    state.applyEnv();
    try {
      await expect(
        createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway tls: cert/key missing");
      expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await state.cleanup();
    }
  });
});
