import assert from "node:assert/strict";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getLegacyPluginSdkResourceHost,
  type LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
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
      const releases: Array<ReturnType<typeof vi.fn<() => void>>> = [];
      const metadataSpy = vi
        .spyOn(metadataModule, "retainGatewayPluginMetadata")
        .mockImplementation(() => {
          const release = vi.fn(retainMetadata());
          releases.push(release);
          return release;
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
          const inspection = new PluginRegistryInspectionResources();
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
        expect(releases).toHaveLength(1);
        expect(releases[0]).not.toHaveBeenCalled();
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
        expect(releases[0]).toHaveBeenCalledOnce();
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
        for (const release of releases) {
          release();
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
