import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getLegacyPluginSdkResourceHost,
  type LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import { bindPluginRegistryResourceOwner } from "../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { createStartupTestState, gatewayStartupOptions } from "./server-startup.test-support.js";

const startupTraceEventLoopDelay = vi.hoisted(() => ({
  instances: [] as Array<{
    disable: ReturnType<typeof vi.fn>;
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

const token = "gateway-startup-lifetime-token";
const startupOptions = () => gatewayStartupOptions(token);

async function configureStartup(
  state: Awaited<ReturnType<typeof createStartupTestState>>,
  port: number,
  gateway: NonNullable<OpenClawConfig["gateway"]> = {},
  config: OpenClawConfig = {},
) {
  await state.writeConfig({
    ...config,
    gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port, ...gateway },
  });
  state.applyEnv();
}

function expectStartupCleanupError(failure: unknown, cause: unknown) {
  assert(failure instanceof AggregateError);
  expect(failure.name).toBe("GatewayStartupCleanupError");
  expect(failure.cause).toBe(cause);
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(cause);
  return failure;
}

describe("Gateway startup lifetime", () => {
  it.each(["close", "startup failure"] as const)(
    "releases idle prepared donor custody before registry retirement during %s",
    async (entry) => {
      await using state = await createStartupTestState(`gateway-idle-donor-${entry}`);
      startupTraceEventLoopDelay.instances.length = 0;
      state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
      const port = await getFreePort();
      await configureStartup(state, port);
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
        const options = startupOptions();
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
        expect(startupTraceEventLoopDelay.instances[0]?.disable).toHaveBeenCalledOnce();
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
      await using state = await createStartupTestState("gateway-invalid-config-startup-trace");
      state.envVars.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
      await state.writeConfig({ gateway: { mode: 42 } });
      state.applyEnv();
      const bootstrapModule = await import("./server-startup-bootstrap.js");
      const metadataModule = await import("../plugins/plugin-metadata-lifecycle.js");
      const secretsModule = await import("../secrets/runtime-state.js");
      const bootstrap = bootstrapModule.prepareGatewayServerBootstrap;
      const retainMetadata = metadataModule.retainGatewayPluginMetadata;
      const metadataOwners: ReturnType<typeof retainMetadata>[] = [];
      const released = vi.fn();
      const metadataSpy = vi
        .spyOn(metadataModule, "retainGatewayPluginMetadata")
        .mockImplementation((...metadataArgs) => {
          const owner = retainMetadata(...metadataArgs);
          const close = owner.close.bind(owner);
          vi.spyOn(owner, "close").mockImplementation(async (...args) => {
            const result = await close(...args);
            released();
            return result;
          });
          metadataOwners.push(owner);
          return owner;
        });
      const clearSecrets = secretsModule.clearSecretsRuntimeSnapshotState;
      const clearSecretsSpy = vi.spyOn(secretsModule, "clearSecretsRuntimeSnapshotState");
      const clearError = new Error("synthetic secrets clear failure");
      if (clearFails) {
        clearSecretsSpy.mockImplementation(() => {
          clearSecrets();
          throw clearError;
        });
      }
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
        expect(released).not.toHaveBeenCalled();
        expect(clearSecretsSpy).not.toHaveBeenCalled();
        resume.resolve();
        const failure = await outcome;
        expect(startupError).toBeInstanceOf(Error);
        if (disposalFails) {
          const sdkFailure = await sdkHost?.close().catch((error: unknown) => error);
          const failures: unknown[] = expectStartupCleanupError(failure, startupError).errors;
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
        expect(released).toHaveBeenCalledOnce();
      } finally {
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
        for (const owner of metadataOwners) {
          await owner.close();
        }
      }
    },
  );

  it("stops TLS renewal when the started Gateway closes", async () => {
    await using state = await createStartupTestState("gateway-tls-renewal-close");
    const port = await getFreePort();
    const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
    const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
    await configureStartup(
      state,
      port,
      { tls: { enabled: true, autoGenerate: false, certPath, keyPath } },
      { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } } },
    );
    const renewalModule = await import("./server-tls-renewal.js");
    const startRenewal = renewalModule.startGatewayTlsRenewal;
    let renewal: ReturnType<typeof startRenewal>;
    const stopped = vi.fn();
    const renewalSpy = vi
      .spyOn(renewalModule, "startGatewayTlsRenewal")
      .mockImplementation((params) => {
        renewal = startRenewal(params);
        if (renewal) {
          const stop = renewal.stop.bind(renewal);
          renewal.stop = async () => {
            await stop();
            stopped();
          };
        }
        return renewal;
      });
    let server: GatewayServer | undefined;
    try {
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, startupOptions());
      await server.startupSettled;
      expect(renewal).toBeDefined();
      expect(stopped).not.toHaveBeenCalled();
      await expect(server.close()).resolves.toBeUndefined();
      expect(stopped).toHaveBeenCalledOnce();
    } finally {
      // Retire the fixture's watchers even when broken registration makes close fail.
      await renewal?.stop();
      try {
        await server?.close();
      } finally {
        renewalSpy.mockRestore();
      }
    }
  });

  it.for(["clean", "failed"] as const)(
    "joins deferred startup failure while reporting %s cleanup independently",
    async (cleanup) => {
      const port = await getFreePort();
      await using state = await createStartupTestState(`gateway-deferred-startup-${cleanup}`);
      const startupError = new Error("deferred startup failed");
      const cleanupError = new Error("deferred startup cleanup failed");
      const startup = createDeferred();
      const entered = createDeferred();
      const drainEntered = createDeferred();
      let failCleanup = cleanup === "failed";
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let publishedStartup: Promise<void> | undefined;
      let closeOutcome: Promise<unknown> | undefined;
      const startupModule = await import("./server-startup-finish.js");
      const finishStartup = startupModule.finishGatewayStartup;
      vi.spyOn(startupModule, "finishGatewayStartup").mockImplementation(async (params) => {
        kernel = params.kernelRuntime;
        const result = await finishStartup(params);
        publishedStartup = kernel.connectionWork.track(async () => {
          await result.startupSettled;
          entered.resolve();
          await startup.promise;
        });
        void publishedStartup.catch(() => {});
        return { ...result, startupSettled: publishedStartup };
      });
      const stop = vi.fn(async () => {
        expect(getLegacyPluginSdkResourceHost()).toBe(kernel?.sdkResourceHost);
        if (failCleanup) {
          throw cleanupError;
        }
      });
      try {
        await configureStartup(state, port);
        const { startGatewayServerCore } = await import("./server-start.js");
        const server = await startGatewayServerCore(port, startupOptions());
        await entered.promise;
        const owner = kernel!;
        owner.registerGatewayLifetimeSidecars({ stop });
        const terminalDispose = vi.spyOn(owner.terminalSessions, "disposeAll");
        const drain = owner.connectionWork.drain.bind(owner.connectionWork);
        vi.spyOn(owner.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve();
          await drain();
        });
        const settled = vi.fn((error?: unknown) => error);
        closeOutcome = server.close({ reason: "gateway startup failed" }).then(settled, settled);
        await drainEntered.promise;
        await nextTurn();
        for (const effect of [settled, terminalDispose, stop]) {
          expect(effect).not.toHaveBeenCalled();
        }
        startup.reject(startupError);
        const outcome = await closeOutcome;
        if (failCleanup) {
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
        await expect(server.startupSettled).rejects.toBe(startupError);
      } finally {
        startup.reject(startupError);
        try {
          await Promise.allSettled([publishedStartup, closeOutcome]);
          failCleanup = false;
          await kernel?.closeOnStartupFailure();
        } finally {
          vi.restoreAllMocks();
        }
      }
    },
  );

  it.each(["clean", "failed", "held-process", "held-embedded"] as const)(
    "releases post-ready work and joins or bounds startup rollback (%s)",
    async (mode) => {
      const port = await getFreePort();
      await using state = await createStartupTestState("gateway-post-ready-startup-failure");
      const startupError = new Error("startup failed after post-attach installation");
      const cleanupError = new Error("startup cleanup failed");
      const held = mode.startsWith("held-");
      const processOwned = mode === "held-process";
      let failCleanup = mode === "failed";
      const stopEntered = createDeferred();
      const releaseStop = createDeferred();
      const stop = vi.fn(async () => {
        stopEntered.resolve();
        if (held) {
          await releaseStop.promise;
        }
        if (failCleanup) {
          throw cleanupError;
        }
      });
      const emergencyRelease = createDeferred();
      const drainEntered = createDeferred<boolean>();
      const resumed = vi.fn();
      let barrierReleased = false;
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let postReadyWork: Promise<void> | undefined;
      let startupOutcome: Promise<unknown> | undefined;
      const startupModule = await import("./server-startup-finish.js");
      const finishStartup = startupModule.finishGatewayStartup;
      vi.spyOn(startupModule, "finishGatewayStartup").mockImplementation(async (params) => {
        await (
          await finishStartup(params)
        ).startupSettled;
        const owner = (kernel = params.kernelRuntime);
        owner.registerGatewayLifetimeSidecars({ stop });
        const transport = owner.transportBridge.current()!;
        expect(transport.httpServer.listening).toBe(true);
        const barrier = params.waitForPostReadyWork().then(() => {
          barrierReleased = true;
        });
        postReadyWork = owner.connectionWork.track(async () => {
          await Promise.race([barrier, emergencyRelease.promise]);
          resumed({
            closing: owner.lifecycle.closePreludeStarted,
            listening: transport.httpServer.listening,
          });
        });
        const drain = owner.connectionWork.drain.bind(owner.connectionWork);
        vi.spyOn(owner.connectionWork, "drain").mockImplementation(async () => {
          drainEntered.resolve(barrierReleased);
          await drain();
        });
        if (held) {
          vi.useFakeTimers();
        }
        throw startupError;
      });
      try {
        await configureStartup(state, port);
        const { startGatewayServerCore } = await import("./server-start.js");
        startupOutcome = startGatewayServerCore(port, {
          ...startupOptions(),
          exitAfterStartupFailure: () => processOwned,
        }).catch((error: unknown) => error);
        expect(await Promise.race([drainEntered.promise, startupOutcome])).toBe(true);
        if (held) {
          await stopEntered.promise;
          const settled = vi.fn();
          void startupOutcome.then(settled);
          await vi.advanceTimersByTimeAsync(10_000);
          expect(settled).toHaveBeenCalledTimes(processOwned ? 1 : 0);
          releaseStop.resolve();
          vi.useRealTimers();
        }
        const failure = await startupOutcome;
        if (processOwned || failCleanup) {
          expectStartupCleanupError(failure, startupError);
          expect(formatErrorMessage(failure)).toContain(
            processOwned ? "cleanup exceeded 5000ms" : cleanupError.message,
          );
        } else {
          expect(failure).toBe(startupError);
        }
        expect(resumed).toHaveBeenCalledExactlyOnceWith({ closing: true, listening: true });
        expect(kernel?.transportBridge.current()?.httpServer.listening).toBe(
          failCleanup || processOwned,
        );
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (!failCleanup && !processOwned) {
          expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
        }
      } finally {
        releaseStop.resolve();
        emergencyRelease.resolve();
        vi.useRealTimers();
        try {
          await Promise.all([startupOutcome, postReadyWork]);
          failCleanup = false;
          await kernel?.closeOnStartupFailure();
        } finally {
          vi.restoreAllMocks();
        }
      }
    },
  );
});
