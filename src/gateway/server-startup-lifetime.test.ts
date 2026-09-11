import assert from "node:assert/strict";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import {
  closePreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimeClose,
} from "../agents/prepared-model-runtime.lifecycle.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { selectCurrentPluginMetadataCache } from "../plugins/current-plugin-metadata-state.js";
import {
  getLegacyPluginSdkResourceHost,
  type LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import {
  bindPluginRegistryResourceOwner,
  markPluginRegistryActive,
} from "../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";

const startupTraceEventLoopDelay = vi.hoisted(() => ({
  instances: [] as Array<{
    disable: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    percentile: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    monitorEventLoopDelay: vi.fn(() => {
      const instance = {
        disable: vi.fn(),
        enable: vi.fn(),
        percentile: vi.fn(() => 0),
        reset: vi.fn(),
      };
      startupTraceEventLoopDelay.instances.push(instance);
      return { ...instance, max: 0 };
    }),
  };
});

function createStartupTestState(label: string) {
  return createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
}

function registerSecretsClearFailure(
  register: (hook: () => void) => void,
  error: Error,
): () => void {
  let failure: Error | undefined = error;
  register(function failRegisteredSecretsClear() {
    if (failure) {
      throw failure;
    }
  });
  return () => {
    failure = undefined;
  };
}

describe("Gateway startup lifetime", () => {
  it.each(["donor", "metadata cache", "metadata borrower"] as const)(
    "releases idle prepared %s custody when one of two Gateways closes",
    async (mode) => {
      const state = await createStartupTestState("gateway-nonfinal-prepared-donor");
      const token = "gateway-nonfinal-donor-token";
      const pluginId = "nonfinal-donor";
      const pluginRoot = state.statePath("plugin");
      await state.writeJson("plugin/package.json", {
        name: pluginId,
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.ts"] },
      });
      await state.writeJson("plugin/openclaw.plugin.json", {
        id: pluginId,
        configSchema: { type: "object", properties: {} },
      });
      await state.writeText(
        "plugin/index.ts",
        `
      export default { id: "nonfinal-donor", register(api) {
        if (api.registrationMode === "full") api.registerWidgetPresenter({
          target: "node_panel", description: "Synthetic donor",
          async availability() { return { ok: true, value: { available: true } }; },
          async present() { return { ok: true, value: {} }; },
        });
      } };
    `,
      );
      const config: OpenClawConfig = {
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false } },
        plugins: {
          enabled: mode === "donor",
          allow: [pluginId],
          load: { paths: [pluginRoot] },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(config);
      state.applyEnv();
      const previous = captureActivePluginRegistrySnapshot();
      const bootstrapModule = await import("./server-startup-bootstrap.js");
      const bootstrap = bootstrapModule.prepareGatewayServerBootstrap;
      const registries: ReturnType<typeof loadAndActivateRootPluginRegistry>[] = [];
      const bootstrapSpy = vi
        .spyOn(bootstrapModule, "prepareGatewayServerBootstrap")
        .mockImplementation(async (...args) => {
          const result = await bootstrap(...args);
          const registry = loadAndActivateRootPluginRegistry({
            config,
            env: state.env,
            workspaceDir: state.workspaceDir,
            cache: false,
          });
          result.pluginBootstrap.pluginRegistry = registry;
          registries.push(registry);
          return result;
        });
      const caches: ReturnType<typeof createPluginCache>[] = [];
      const servers: GatewayServer[] = [];
      let stopRetirementProbe: (() => void) | undefined;
      const leases: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>>[] = [];
      let closing: Promise<void> | undefined;
      const input = (id: string) => ({
        config,
        agentDir: state.agentDir(id),
        workspaceDir: state.workspaceDir,
        env: state.env,
        skipCredentials: true,
      });
      try {
        const { startGatewayServerCore } = await import("./server-start.js");
        for (const id of ["closing", "survivor"]) {
          const cache = createPluginCache();
          caches.push(cache);
          selectCurrentPluginMetadataCache(cache);
          await withPluginCache(cache, async () => {
            const server = await startGatewayServerCore(await getFreePort(), {
              auth: { mode: "token", token },
              bind: "loopback",
              controlUiEnabled: false,
              sidecarStartup: "defer",
            });
            servers.push(server);
            await server.startupSettled;
            const lease = await acquireAgentRunPreparedModelRuntime(input(id), {
              retainIdleRunOwner: true,
            });
            leases.push(lease);
            expect(getPluginMetadataSnapshotCache(lease.snapshot.metadataSnapshot)).toBe(cache);
            expect(lease.snapshot.pluginRegistry?.widgetPresenters).toHaveLength(
              mode === "donor" ? 1 : 0,
            );
          });
        }
        expect(registries[0]).not.toBe(registries[1]);
        const [first, survivor] = leases;
        const [closingRegistry] = registries;
        const [closingServer] = servers;
        assert(first && survivor && closingRegistry && closingServer);
        const donorRecord = closingRegistry.plugins.find((record) => record.id === pluginId);
        const donor = donorRecord && getPluginInstance(donorRecord);
        if (mode === "donor") {
          assert(donor);
          expect(donor.hasRetainedConsumers).toBe(true);
        }
        const idle = await acquireAgentRunPreparedModelRuntime(input("closing"), {
          retainIdleRunOwner: true,
        });
        leases.push(idle);
        await idle[Symbol.asyncDispose]();
        await first[Symbol.asyncDispose]();
        if (donor) {
          expect(donor.hasRetainedConsumers).toBe(true);
        }
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              "fixture:default": {
                type: "api_key",
                provider: "fixture",
                key: "synthetic-donor-key",
              },
            },
          },
          "closing",
        );
        const refreshed = await acquirePublishedPreparedModelRuntime(input("closing"));
        leases.push(refreshed);
        expect(refreshed.snapshot).not.toBe(first.snapshot);
        expect(refreshed.pluginGeneration).toBe(first.pluginGeneration);
        if (mode !== "metadata borrower") {
          await refreshed[Symbol.asyncDispose]();
        }
        markPluginRegistryActive(closingRegistry);
        expect(await prepareModelRuntimeSnapshot(input("closing"))).toBe(refreshed.snapshot);
        const disposalEntered = createDeferred();
        if (donor) {
          const dispose = donor.dispose.bind(donor);
          const spy = vi.spyOn(donor, "dispose").mockImplementation((...args) => {
            disposalEntered.resolve();
            return dispose(...args);
          });
          stopRetirementProbe = () => spy.mockRestore();
        } else {
          const cacheModule = await import("../plugins/plugin-cache.js");
          const retire = cacheModule.retirePluginCache;
          const spy = vi.spyOn(cacheModule, "retirePluginCache").mockImplementation((...args) => {
            const result = retire(...args);
            if (args[0] === caches[0]) {
              disposalEntered.resolve();
            }
            return result;
          });
          stopRetirementProbe = () => spy.mockRestore();
        }
        closing = closingServer.close();
        await disposalEntered.promise;
        // Registry retirement must revoke its cached publication without closing the survivor.
        await expect(
          prepareModelRuntimeSnapshot(input("closing")).then(() => undefined),
        ).rejects.toThrow();
        if (mode === "metadata borrower") {
          expect(caches[0]?.retirement).toBeUndefined();
          expect(getPluginMetadataSnapshotCache(refreshed.snapshot.metadataSnapshot)).toBe(
            caches[0],
          );
          await refreshed[Symbol.asyncDispose]();
        }
        await closing;
        if (donor) {
          expect(donor.hasRetainedConsumers).toBe(false);
        }
        expect(await prepareModelRuntimeSnapshot(input("survivor"))).toBe(survivor.snapshot);
        const presenter = survivor.snapshot.pluginRegistry?.widgetPresenters[0]?.presenter;
        if (mode === "donor") {
          assert(presenter);
          await expect(presenter.availability({})).resolves.toMatchObject({
            ok: true,
            value: { available: true },
          });
        }
        const admitted = await acquireAgentRunPreparedModelRuntime(input("survivor"));
        leases.push(admitted);
        expect(admitted.snapshot).toBe(survivor.snapshot);
      } finally {
        // A failing assertion still releases only this fixture's model claims before joining close.
        for (const lease of leases) {
          await lease[Symbol.asyncDispose]();
        }
        await closePreparedModelRuntimeSnapshots();
        await closing;
        for (const server of servers) {
          await server.close();
        }
        stopRetirementProbe?.();
        bootstrapSpy.mockRestore();
        restoreActivePluginRegistrySnapshot(previous);
        await state.cleanup();
      }
    },
  );

  it.each(["close", "startup failure"] as const)(
    "releases idle prepared donor custody before registry retirement during %s",
    async (entry) => {
      const state = await createStartupTestState(`gateway-idle-donor-${entry}`);
      const port = await getFreePort();
      const token = "gateway-idle-donor-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      const previous = captureActivePluginRegistrySnapshot();
      const bootstrapModule = await import("./server-startup-bootstrap.js");
      const stateModule = await import("./server-runtime-state-prepare.js");
      const bootstrap = bootstrapModule.prepareGatewayServerBootstrap;
      const disposalEntered = createDeferred<{ modelClosed: boolean; sdkClosed: boolean }>();
      const disposed = vi.fn();
      const sdkReads: Array<{ value: string; modelClosed: boolean }> = [];
      let modelClosed = false;
      let sdkClosed = false;
      let releaseModel: (() => Promise<void>) | undefined;
      let sdkHost: LegacyPluginSdkResourceHost | undefined;
      let server: GatewayServer | undefined;
      let outcome: Promise<unknown> | undefined;
      const startupError = new Error("synthetic kernel state preparation failed");
      const bootstrapSpy = vi
        .spyOn(bootstrapModule, "prepareGatewayServerBootstrap")
        .mockImplementation(async (...args) => {
          const result = await bootstrap(...args);
          const registry = createEmptyPluginRegistry();
          result.pluginBootstrap.pluginRegistry = registry;
          const record = createPluginRecord({ id: "idle-shutdown-donor" });
          registry.plugins.push(record);
          const instance = new PluginInstance(record.id, { record, registry });
          instance.lifecycle.onDispose(disposed);
          setActivePluginRegistry(registry);
          const primary = createEmptyPluginRegistry();
          const view = bindPluginRegistryResourceOwner({ ...primary, plugins: [record] }, primary);
          const inspection = new PluginRegistryInspectionResources(retireInspectionInstances);
          inspection.attach(primary);
          inspection.attach(view);
          inspection.adoptInvocations(view, registry);
          releaseModel = async () => {
            await inspection.release();
            modelClosed = true;
          };
          const unregister = registerPreparedModelRuntimeClose(async () => {
            await releaseModel?.();
            unregister();
          });
          sdkHost = getLegacyPluginSdkResourceHost();
          const consumer = instance.retainConsumer();
          const read = consumer.wrap(instance.wrap(() => "donor available"));
          sdkHost.adopt(consumer, {
            release: async () => {
              try {
                sdkReads.push({ value: read(), modelClosed });
              } finally {
                consumer.release();
                sdkClosed = true;
              }
            },
          });
          const dispose = instance.dispose.bind(instance);
          vi.spyOn(instance, "dispose").mockImplementation((...disposeArgs) => {
            disposalEntered.resolve({ modelClosed, sdkClosed });
            return dispose(...disposeArgs);
          });
          return result;
        });
      const stateSpy =
        entry === "startup failure"
          ? vi.spyOn(stateModule, "prepareGatewayKernelState").mockRejectedValue(startupError)
          : undefined;
      try {
        const options = {
          auth: { mode: "token" as const, token },
          bind: "loopback" as const,
          controlUiEnabled: false,
          sidecarStartup: "defer" as const,
        };
        if (entry === "close") {
          const { startGatewayServerCore } = await import("./server-start.js");
          server = await startGatewayServerCore(port, options);
          await server.startupSettled;
          outcome = server.close().catch((error: unknown) => error);
        } else {
          outcome = createGatewayKernel(port, options).catch((error: unknown) => error);
        }
        const boundary = await Promise.race([
          disposalEntered.promise,
          outcome.then(() => {
            throw new Error("Gateway cleanup omitted its donor");
          }),
        ]);
        expect(boundary).toEqual({ modelClosed: true, sdkClosed: true });
        expect(await outcome).toBe(entry === "startup failure" ? startupError : undefined);
        expect(sdkReads).toEqual([{ value: "donor available", modelClosed: false }]);
        expect(disposed).toHaveBeenCalledOnce();
      } finally {
        // On the broken ordering, release only this fixture's idle claims so close can join.
        await sdkHost?.close();
        await releaseModel?.();
        await outcome;
        await server?.close();
        stateSpy?.mockRestore();
        bootstrapSpy.mockRestore();
        restoreActivePluginRegistrySnapshot(previous);
        await state.cleanup();
      }
    },
  );

  it.each([
    { disposalFails: false, clearFails: false },
    { disposalFails: true, clearFails: false },
    { disposalFails: true, clearFails: true },
  ])(
    "closes early startup owners when invalid config prevents bootstrap (SDK failure: $disposalFails, clear failure: $clearFails)",
    async ({ disposalFails, clearFails }) => {
      startupTraceEventLoopDelay.instances.length = 0;
      const state = await createStartupTestState("gateway-invalid-config-startup-trace");
      state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
      await state.writeConfig({ gateway: { mode: 42 } });
      state.applyEnv();
      const bootstrapModule = await import("./server-startup-bootstrap.js");
      const metadataModule = await import("../plugins/plugin-metadata-lifecycle.js");
      const secretsModule = await import("../secrets/runtime-state.js");
      const bootstrap = bootstrapModule.prepareGatewayServerBootstrap;
      const retainMetadata = metadataModule.retainGatewayPluginMetadata;
      const metadataOwners: Array<{
        owner: ReturnType<typeof retainMetadata>;
        released: ReturnType<typeof vi.fn>;
      }> = [];
      const metadataSpy = vi
        .spyOn(metadataModule, "retainGatewayPluginMetadata")
        .mockImplementation(() => {
          const owner = retainMetadata();
          const released = vi.fn();
          const close = owner.close.bind(owner);
          vi.spyOn(owner, "close").mockImplementation(async (...args) => {
            await close(...args);
            released();
          });
          metadataOwners.push({ owner, released });
          return owner;
        });
      const clearSecretsSpy = vi.spyOn(secretsModule, "clearSecretsRuntimeSnapshotState");
      const clearError = new Error("synthetic registered secrets clear failure");
      const stopClearFailure = clearFails
        ? registerSecretsClearFailure(
            secretsModule.registerSecretsRuntimeStateClearHook,
            clearError,
          )
        : undefined;
      const database = new DatabaseSync(":memory:");
      const entered = createDeferred();
      const resume = createDeferred();
      const disposalError = new Error("synthetic early SDK disposal failure");
      let sdkHost: LegacyPluginSdkResourceHost | undefined;
      let startupError: unknown;
      const bootstrapSpy = vi
        .spyOn(bootstrapModule, "prepareGatewayServerBootstrap")
        .mockImplementation(async (...args) => {
          sdkHost = getLegacyPluginSdkResourceHost();
          const inspection = new PluginRegistryInspectionResources(async () => {});
          inspection.attach(createEmptyPluginRegistry());
          inspection.register("startup-provider", {
            id: "native",
            dispose: async () => {
              entered.resolve();
              await resume.promise;
              database.close();
              if (disposalFails) {
                throw disposalError;
              }
            },
          });
          sdkHost.adopt(inspection, inspection.retain());
          await inspection.release();
          try {
            return await bootstrap(...args);
          } catch (error) {
            startupError = error;
            throw error;
          }
        });
      const outcome = createGatewayKernel().catch((error: unknown) => error);
      try {
        await entered.promise;
        expect(database.isOpen).toBe(true);
        expect(metadataOwners).toHaveLength(1);
        expect(metadataOwners[0]?.released).not.toHaveBeenCalled();
        expect(clearSecretsSpy).not.toHaveBeenCalled();
        resume.resolve();
        const failure = await outcome;
        expect(startupError).toBeInstanceOf(Error);
        if (disposalFails) {
          const sdkFailure = await sdkHost?.close().catch((error: unknown) => error);
          assert(failure instanceof AggregateError);
          const failures: unknown[] = failure.errors;
          expect(failure.name).toBe("GatewayStartupCleanupError");
          expect(failure.cause).toBe(startupError);
          expect(failures).toHaveLength(2);
          expect(failures[0]).toBe(startupError);
          if (clearFails) {
            const cleanupFailure = failures[1];
            assert(cleanupFailure instanceof AggregateError);
            const cleanupErrors: unknown[] = cleanupFailure.errors;
            expect(cleanupFailure.cause).toBe(sdkFailure);
            expect(cleanupErrors).toHaveLength(2);
            expect(cleanupErrors[0]).toBe(sdkFailure);
            expect(cleanupErrors[1]).toBe(clearError);
          } else {
            expect(failures[1]).toBe(sdkFailure);
          }
        } else {
          expect(failure).toBe(startupError);
        }
        expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
        expect(database.isOpen).toBe(false);
        expect(clearSecretsSpy).toHaveBeenCalledOnce();
        expect(metadataOwners[0]?.released).toHaveBeenCalledOnce();
      } finally {
        stopClearFailure?.();
        resume.resolve();
        await outcome;
        bootstrapSpy.mockRestore();
        metadataSpy.mockRestore();
        clearSecretsSpy.mockRestore();
        await sdkHost?.close().catch(() => undefined);
        if (database.isOpen) {
          database.close();
        }
        secretsModule.clearSecretsRuntimeSnapshotState();
        for (const { owner } of metadataOwners) {
          await owner.close();
        }
        await state.cleanup();
      }
    },
  );

  it("closes startup tracing when required TLS material is unavailable", async () => {
    startupTraceEventLoopDelay.instances.length = 0;
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-tls-startup-trace");
    state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
    const token = "gateway-tls-startup-trace-token";
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
      expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
    } finally {
      await state.cleanup();
    }
  });

  it("closes startup tracing when public startup cannot bind its listener", async () => {
    startupTraceEventLoopDelay.instances.length = 0;
    const port = await getFreePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", () => {
        blocker.off("error", reject);
        resolve();
      });
    });
    const state = await createStartupTestState("gateway-public-startup-trace");
    state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
    const token = "gateway-public-startup-trace-token";
    await state.writeConfig({
      gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
    });
    state.applyEnv();
    try {
      const listenModule = await import("./server/http-listen.js");
      const listen = listenModule.listenGatewayHttpServer;
      // The owned blocker cannot leave; retry policy has its own listener tests.
      const listenSpy = vi
        .spyOn(listenModule, "listenGatewayHttpServer")
        .mockImplementation((params) => listen({ ...params, retryEaddrinuse: false }));
      try {
        const { startGatewayServerCore } = await import("./server-start.js");
        await expect(
          startGatewayServerCore(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          }),
        ).rejects.toThrow("another gateway instance is already listening");
        expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
      } finally {
        listenSpy.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
      await state.cleanup();
    }
  });

  it.for(["clean", "failed"] as const)(
    "joins deferred startup failure while reporting %s cleanup independently",
    async (cleanup, { signal }) => {
      const port = await getFreePort();
      const state = await createStartupTestState(`gateway-deferred-startup-${cleanup}-cleanup`);
      const startupError = new Error("deferred startup failed");
      const cleanupError = new Error("deferred startup cleanup failed");
      const startup = createDeferred();
      const startupFailure = startup.promise.catch((error: unknown) => error);
      const startupEntered = createDeferred();
      const drainEntered = createDeferred();
      const releaseStartup = () => startup.reject(startupError);
      signal.addEventListener("abort", releaseStartup, { once: true });
      let failCleanup = cleanup === "failed";
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let server: GatewayServer | undefined;
      let publishedStartup: Promise<void> | undefined;
      let startupOutcome: Promise<unknown> | undefined;
      let closeOutcome: Promise<unknown> | undefined;
      const createKernel = createGatewayKernel;
      const kernelFactory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await createKernel(...args);
          return kernel;
        });
      const startupModule = await import("./server-startup-finish.js");
      const finishStartup = startupModule.finishGatewayStartup;
      const startupFactory = vi
        .spyOn(startupModule, "finishGatewayStartup")
        .mockImplementation(async (...args) => {
          const result = await finishStartup(...args);
          const operation = result.startupSettled.then(async () => {
            startupEntered.resolve();
            await startup.promise;
          });
          publishedStartup = args[0].kernelRuntime.connectionWork.track(() => operation);
          startupOutcome = publishedStartup.catch((error: unknown) => error);
          return { ...result, startupSettled: publishedStartup };
        });
      const cleanupOwner = {
        stop: vi.fn(async () => {
          expect(getLegacyPluginSdkResourceHost()).toBe(kernel?.sdkResourceHost);
          if (failCleanup) {
            throw cleanupError;
          }
        }),
      };
      try {
        const token = "gateway-deferred-startup-cleanup-token";
        await state.writeConfig({
          gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
        });
        state.applyEnv();
        const { startGatewayServerCore } = await import("./server-start.js");
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await startupEntered.promise;
        expect(server.startupSettled).toBe(publishedStartup);
        if (!kernel) {
          throw new Error("Expected the real Gateway kernel");
        }
        const activeKernel = kernel;
        activeKernel.registerGatewayLifetimeSidecars([cleanupOwner]);
        const terminalDispose = vi.spyOn(activeKernel.terminalSessions, "disposeAll");
        const drain = activeKernel.connectionWork.drain.bind(activeKernel.connectionWork);
        vi.spyOn(activeKernel.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve();
          await drain();
        });
        const closeSettled = vi.fn();
        closeOutcome = server.close({ reason: "gateway startup failed" }).then(
          () => {
            closeSettled();
            return undefined;
          },
          (error: unknown) => {
            closeSettled();
            return error;
          },
        );
        await drainEntered.promise;
        await nextTurn();
        expect(closeSettled).not.toHaveBeenCalled();
        expect(terminalDispose).not.toHaveBeenCalled();
        expect(cleanupOwner.stop).not.toHaveBeenCalled();
        releaseStartup();
        expect(await startupOutcome).toBe(startupError);
        const outcome = await closeOutcome;
        if (cleanup === "failed") {
          expect(outcome).toMatchObject({
            errors: [
              {
                message: expect.stringContaining("gateway lifetime sidecars"),
                cause: cleanupError,
              },
              { message: expect.stringContaining("late sidecar cleanup"), cause: cleanupError },
            ],
          });
        } else {
          expect(outcome).toBeUndefined();
        }
        expect(terminalDispose).toHaveBeenCalledOnce();
        expect(cleanupOwner.stop).toHaveBeenCalled();
        await expect(server.startupSettled).rejects.toBe(startupError);
      } finally {
        releaseStartup();
        try {
          await Promise.all([startupFailure, startupOutcome]);
          const outcome = await closeOutcome;
          failCleanup = false;
          if (kernel && (!closeOutcome || outcome !== undefined)) {
            await kernel.closeOnStartupFailure();
          }
          await state.cleanup();
        } finally {
          signal.removeEventListener("abort", releaseStartup);
          startupFactory.mockRestore();
          kernelFactory.mockRestore();
          vi.restoreAllMocks();
        }
      }
    },
  );

  it("releases post-ready startup work after failure before joining cleanup", async () => {
    const port = await getFreePort();
    const state = await createStartupTestState("gateway-post-ready-startup-failure");
    const startupError = new Error("startup failed after post-attach installation");
    const emergencyRelease = createDeferred();
    const drainEntered = createDeferred<{ barrierReleased: boolean }>();
    const resumed = vi.fn<(state: { closing: boolean; listening: boolean }) => void>();
    let barrierReleased = false;
    let emergencyUsed = false;
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    let postReadyWork: Promise<void> | undefined;
    let startupOutcome: Promise<unknown> | undefined;
    let unexpectedServer: GatewayServer | undefined;
    const startupModule = await import("./server-startup-finish.js");
    const finishStartup = startupModule.finishGatewayStartup;
    const startupFactory = vi
      .spyOn(startupModule, "finishGatewayStartup")
      .mockImplementation(async (params) => {
        const result = await finishStartup(params);
        await result.startupSettled;
        const owner = params.kernelRuntime;
        kernel = owner;
        const transport = owner.transportBridge.current();
        if (!transport?.httpServer.listening) {
          throw new Error("Expected the real Gateway listener before startup failure");
        }
        // Minimal boot skips this production continuation; retain the exact
        // public-start barrier and work owner used by nonminimal post-attach.
        const barrier = params.waitForPostReadyWork().then(() => {
          barrierReleased = true;
        });
        const operation = (async () => {
          const releasedBy = await Promise.race([
            barrier.then(() => "gateway" as const),
            emergencyRelease.promise.then(() => "fixture" as const),
          ]);
          emergencyUsed = releasedBy === "fixture";
          resumed({
            closing: owner.lifecycle.closePreludeStarted,
            listening: transport.httpServer.listening,
          });
        })();
        postReadyWork = owner.connectionWork.track(() => operation);
        const drain = owner.connectionWork.drain.bind(owner.connectionWork);
        vi.spyOn(owner.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve({ barrierReleased });
          await drain();
        });
        throw startupError;
      });
    try {
      const token = "gateway-post-ready-startup-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      const { startGatewayServerCore } = await import("./server-start.js");
      startupOutcome = startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }).then(
        (server) => {
          unexpectedServer = server;
          return undefined;
        },
        (error: unknown) => error,
      );
      const boundary = await Promise.race([drainEntered.promise, startupOutcome]);
      expect(boundary).toEqual({ barrierReleased: true });
      expect(await startupOutcome).toBe(startupError);
      await postReadyWork;
      expect(emergencyUsed).toBe(false);
      expect(resumed).toHaveBeenCalledExactlyOnceWith({ closing: true, listening: true });
      expect(kernel?.transportBridge.current()?.httpServer.listening).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
    } finally {
      // A broken catch path is already observable at drain entry. Release only
      // the synthetic tail here so its original cleanup can finish before state removal.
      emergencyRelease.resolve();
      try {
        await Promise.all([startupOutcome, postReadyWork]);
        await unexpectedServer?.close();
        await state.cleanup();
      } finally {
        startupFactory.mockRestore();
        vi.restoreAllMocks();
      }
    }
  });
});
