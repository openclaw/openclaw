import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import * as deviceIdentity from "../infra/device-identity-async.js";
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
import { expectCallCount as expectCalls } from "../test-utils/mock-call-assertions.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { closeKernelFixture, createKernelFixture } from "./server-kernel.fixture-test-support.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import type { GatewayHostLifecycle, GatewayServer } from "./server-public.js";
import { createMaintenanceHandles } from "./server-runtime-services.test-harness.js";
import { expectCoreAgentDatabaseReadiness } from "./server-startup-readiness.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { withPreparedSessionEventRow } from "./session-event-prepared-row.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

function idleSidecar() {
  return { stop: vi.fn(async () => {}) };
}

function dispatchOptions(kernel: Awaited<ReturnType<typeof createGatewayKernel>>) {
  return {
    client: createSyntheticPluginRuntimeClient({ scopes: [...CLI_DEFAULT_OPERATOR_SCOPES] }),
    context: kernel.gatewayRequestContext,
    methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
  };
}

function blockedSidecar(once = true) {
  const entered = createDeferred();
  const gate = createDeferred();
  return {
    entered: entered.promise,
    release: gate.resolve,
    stop: vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      })
      .mockImplementation(() => (once ? Promise.resolve() : gate.promise)),
  };
}

function createRegisteredChannel(plugin: ChannelPlugin) {
  const source = "gateway-kernel-test";
  const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source }]);
  registry.plugins.push(
    createPluginRecord({
      id: plugin.id,
      source,
      origin: "bundled",
      enabled: true,
      configSchema: false,
    }),
  );
  return registry;
}

describe("createGatewayKernel", () => {
  it.each([false, true])(
    "starts recovered channels only before close (closing=%s)",
    async (closing) => {
      const fixture = await createKernelFixture("gateway-kernel-breaker-recovery-close", {
        env: {
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
        },
      });
      const { state } = fixture;
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
      const registry = createRegisteredChannel(channelPlugin);
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      try {
        stageActivePluginRegistry(registry, null, "default");
        await fixture.configure({
          channels: {
            telegram: {
              accounts: {
                default: { botToken: "telegram-breaker-recovery-token" },
              },
            },
          },
        });
        kernel = await fixture.open({
          channelAutostartSuppression: {
            reason: "crash-loop-breaker",
            message: "safe mode",
          },
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
        await closeKernelFixture(kernel, state, () =>
          restoreActivePluginRegistrySnapshot(originalPluginRegistry),
        );
      }
    },
  );

  it.for(["direct", "public"] as const)(
    "fences hosted authority and joins shutdown owners during %s close",
    async (entry, { signal }) => {
      const fixture = await createKernelFixture(`gateway-kernel-${entry}-close-readiness`);
      const { state, port } = fixture;
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
        await fixture.configure();
        const options = {
          bootId,
          ...fixture.serverOptions,
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
          connect: gatewayConnect(["operator.read"], { platform: "web" }),
          authenticatedUserProfile: gatewayProfile(
            ensureProfileForEmail("mention-reader@example.test").id,
            "Reader",
          ),
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
          stopScheduledServices: kernel.runtimeState.stopScheduledServices,
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
        expectCalls(0, terminalDispose, gatewayStop);
        configReloaderStop.resolve();
        await nextTurn();
        expect(reloadSettled).toHaveBeenCalledOnce();
        if (server) {
          // Finishing reload alone must not bypass the other admitted producer.
          expectCalls(0, terminalDispose, gatewayStop);
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
          expectCalls(1, terminalDispose, gatewayStop);
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
    const fixture = await createKernelFixture("gateway-kernel-deferred-readiness", {
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
    });
    const { state, open: openKernel } = fixture;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    try {
      await fixture.configure({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, worker: {} },
        },
      });
      kernel = await openKernel();
      const activeKernel = kernel;

      const dispatch = (method: string, params: unknown) =>
        dispatchGatewayRequestInProcess(method, params, dispatchOptions(activeKernel));
      const runId = "deferred-readiness-chat";
      const chatParams = {
        sessionKey: "agent:main:deferred-readiness",
        message: "readiness truth",
        idempotencyKey: runId,
      };

      const getReadiness = kernel.createHttpTransportOptions().getReadiness;
      const notReady = { ready: false, failing: ["startup-sidecars"] };
      expect(getReadiness()).toMatchObject(notReady);
      await expect(dispatch("chat.send", chatParams)).rejects.toThrow(
        "chat.send unavailable during gateway startup",
      );

      kernel.dedupe.set(`chat:${runId}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok" },
      });
      kernel.kernel.unlockStartupMethods();
      kernel.kernel.markSidecarsReady();

      expect(getReadiness()).toMatchObject(notReady);
      kernel.kernel.setDispatchReady(true);
      expect(kernel.createHttpTransportOptions().getStartup?.()).toMatchObject({
        ok: true,
        status: "started",
      });
      expectCoreAgentDatabaseReadiness(getReadiness, state);
      await expect(dispatch("chat.send", chatParams)).resolves.toEqual({ runId, status: "ok" });

      const { promise: firstStop, resolve: releaseFirstStop } = createDeferred();
      const reentrantSidecar = idleSidecar();
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

      const postReadySidecar = blockedSidecar();
      kernel.registerPostReadySidecars(postReadySidecar);
      const connectionSidecar = blockedSidecar();
      kernel.registerConnectionDependentSidecars(connectionSidecar);
      const closeTransport = vi.fn(() => releaseConnection());
      const releaseConnection = kernel.connectionWork.registerConnection(closeTransport);
      const closePreludeReached = vi.spyOn(kernel.watchNodeHttpRuntime, "close");
      const closing = kernel.closeOnStartupFailure();
      void closing.catch(() => undefined);
      await connectionSidecar.entered;
      const lateConnectionSidecar = blockedSidecar(false);
      kernel.registerConnectionDependentSidecars(lateConnectionSidecar);
      const lateGeneralSidecar = idleSidecar();
      const latePostReadySidecar = idleSidecar();
      kernel.registerGatewayLifetimeSidecars(lateGeneralSidecar);
      kernel.registerPostReadySidecars(latePostReadySidecar);
      expect(closeTransport).not.toHaveBeenCalled();
      connectionSidecar.release();
      await vi.waitFor(() => expect(lateConnectionSidecar.stop).toHaveBeenCalledOnce());
      expect(closeTransport).not.toHaveBeenCalled();
      expectCalls(0, lifetimeSidecar.stop, lateGeneralSidecar.stop, latePostReadySidecar.stop);
      lateConnectionSidecar.release();
      await vi.waitFor(() => expect(lifetimeSidecar.stop).toHaveBeenCalledOnce());
      expectCalls(1, closeTransport, connectionSidecar.stop);
      expect(() => kernel?.registerConnectionDependentSidecars(lateConnectionSidecar)).toThrow(
        "cannot publish a Gateway sidecar after shutdown sealed its owner",
      );
      const lateSidecar = idleSidecar();
      kernel.registerGatewayLifetimeSidecars(lifetimeSidecar, lateSidecar);
      const lateStop = kernel.stopRegisteredGatewayLifetimeSidecars();
      releaseFirstStop();

      await expect(reentrantStop).resolves.toBeUndefined();
      await expect(lateStop).resolves.toBeUndefined();
      await vi.waitFor(() => expect(postReadySidecar.stop).toHaveBeenCalledOnce());
      const lateLifetimeSidecar = blockedSidecar(false);
      kernel.registerGatewayLifetimeSidecars(lateLifetimeSidecar);
      const markClosed = vi.fn();
      void closing.then(markClosed, markClosed);
      postReadySidecar.release();
      await vi.waitFor(() => expect(closePreludeReached).toHaveBeenCalledOnce());
      expect(markClosed).not.toHaveBeenCalled();
      const duringSealSidecar = idleSidecar();
      kernel.registerGatewayLifetimeSidecars(duringSealSidecar);
      lateLifetimeSidecar.release();
      await expect(closing).resolves.toBeUndefined();
      closePreludeReached.mockRestore();
      expectCalls(
        1,
        lifetimeSidecar.stop,
        trailingSidecar,
        lateGeneralSidecar.stop,
        latePostReadySidecar.stop,
        reentrantSidecar.stop,
        lateSidecar.stop,
        duringSealSidecar.stop,
        postReadySidecar.stop,
      );
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([]);
      expect(kernel.runtimeState.postReadySidecars.snapshot()).toEqual([]);

      const postSealSidecar = idleSidecar();
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
      const successfulPeer = idleSidecar();
      kernel = await openKernel();
      kernel.registerGatewayLifetimeSidecars(persistentSidecar, successfulPeer);

      await expect(kernel.closeOnStartupFailure()).rejects.toMatchObject({
        errors: ["gateway lifetime sidecars", "late sidecar cleanup"].map((step) => ({
          message: `shutdown step failed (${step}): ${persistentError.message}`,
          cause: persistentError,
        })),
      });
      expectCalls(1, persistentStop, successfulPeer.stop);
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([persistentSidecar]);

      await expect(kernel.closeOnStartupFailure()).resolves.toBeUndefined();
      expect(persistentStop).toHaveBeenCalledTimes(2);
      expect(successfulPeer.stop).toHaveBeenCalledOnce();
      expect(kernel.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([]);
    } finally {
      await closeKernelFixture(kernel, state);
    }
  });

  it("dispatches without a transport when optional chat identity bootstrap fails", async ({
    signal,
  }) => {
    const fixture = await createKernelFixture("gateway-kernel-no-transport");
    const { state } = fixture;
    const originalPluginRegistry = captureActivePluginRegistrySnapshot();
    const inspectAccount = vi.fn(() => ({ enabled: true, configured: true }));
    const capturedRegistryCleanup = vi.fn();
    const ambientPlugin = createChannelTestPluginBase({
      id: "telegram",
      config: { inspectAccount },
    });
    const ambientRegistry = createRegisteredChannel(ambientPlugin);
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
      await fixture.configure();
      stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");

      kernel = await fixture.open();
      expect(loadIdentity).toHaveBeenCalledOnce();
      expect(kernel.transportBridge.current()).toBeUndefined();
      await expect(kernel.transportBridge.ensureSandboxHostPort()).rejects.toThrow(
        "Gateway listener must start before the sandbox host",
      );

      kernel.kernel.setDispatchReady(true);
      await expect(
        dispatchGatewayRequestInProcess("health", {}, dispatchOptions(kernel)),
      ).resolves.toEqual(expect.objectContaining({ ok: true }));

      const idempotencyKey = "kernel-factory-agent";
      kernel.dedupe.set(`agent:${idempotencyKey}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId: "kernel-run", status: "ok", summary: "cached" },
      });
      await expect(
        kernel.gatewayInstanceRuntime.lifecycle.dispatchAgent({
          message: "kernel factory proof",
          idempotencyKey,
        }),
      ).resolves.toEqual({ runId: "kernel-run", status: "ok", summary: "cached" });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      loadIdentity.mockRestore();
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        try {
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
    const fixture = await createKernelFixture("gateway-kernel-tls-failure");
    const { state } = fixture;
    await fixture.configure({
      gateway: {
        tls: {
          enabled: true,
          autoGenerate: false,
          certPath: state.path("missing-cert.pem"),
          keyPath: state.path("missing-key.pem"),
        },
      },
    });
    try {
      await expect(fixture.open()).rejects.toThrow("gateway tls: cert/key missing");
      expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await state.cleanup();
    }
  });
});
