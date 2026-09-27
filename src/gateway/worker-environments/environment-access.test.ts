import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "../../../packages/gateway-client/src/websocket.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as observeBridge from "../desktop/observe-bridge.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import type { WorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import { createWorkerNodePortalCarrier } from "./portal-node-carrier.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerTunnelManager, type WorkerTunnelManager } from "./tunnel.js";
import { measureLaunchTurn } from "./worker-turn-launcher.test-support.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  it("drains all tunnel owners before reporting an independent shutdown failure", async () => {
    const shutdownError = new Error("SSH tunnel shutdown failed");
    const nodeShutdown = createDeferred();
    const portalShutdown = createDeferred();
    const portalStopStarted = createDeferred();
    const nodePortalCarrier = createWorkerNodePortalCarrier({ store: support.testState.store });
    vi.spyOn(nodePortalCarrier, "stopAll").mockImplementation(async () => {
      portalStopStarted.resolve();
      await portalShutdown.promise;
    });
    const tunnelManager = {
      stopAll: vi.fn().mockRejectedValueOnce(shutdownError).mockResolvedValue(undefined),
    } as unknown as WorkerTunnelManager;
    const nodeTunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => await nodeShutdown.promise),
    };
    const nodeDesktopCarrier = {
      bindRuntime: vi.fn(),
      observe: vi.fn(),
      launchApp: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerNodeDesktopCarrier;
    const workerService = support.createService(support.createProvider(), {
      tunnelManager,
      nodeTunnelManager,
      nodeDesktopCarrier,
      nodePortalCarrier,
    });
    const stopping = workerService.stop();
    const settled = vi.fn();
    void stopping.then(settled, settled);

    try {
      await support.waitForFast(() => expect(nodeTunnelManager.stopAll).toHaveBeenCalledOnce());
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).not.toHaveBeenCalled();
      expect(nodeDesktopCarrier.stopAll).toHaveBeenCalledOnce();

      nodeShutdown.resolve();
      await portalStopStarted.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).not.toHaveBeenCalled();
      portalShutdown.resolve();
      await expect(stopping).rejects.toBe(shutdownError);
    } finally {
      nodeShutdown.resolve();
      portalShutdown.resolve();
      await stopping.catch(() => undefined);
    }
  });

  it("drains tunnels and artifacts while retaining inference and artifact shutdown failures", async () => {
    const inferenceFailure = new Error("inference recovery write failed");
    const artifactFailure = new Error("bootstrap artifact cleanup failed");
    const inferenceStore = createWorkerInferenceStore({ path: support.testState.stateDb.path });
    vi.spyOn(inferenceStore, "recoverPending").mockRejectedValue(inferenceFailure);
    const tunnelEntered = createDeferred();
    const tunnelClosed = createDeferred();
    const artifactEntered = createDeferred();
    const artifactClosed = createDeferred();
    const tunnelManager = createWorkerTunnelManager();
    vi.spyOn(tunnelManager, "stopAll").mockImplementation(async () => {
      tunnelEntered.resolve();
      await tunnelClosed.promise;
    });
    const workerService = support.createService(support.createProvider(), {
      inferenceStore,
      tunnelManager,
      closeNodeBootstrapArtifacts: async () => {
        artifactEntered.resolve();
        await artifactClosed.promise;
        throw artifactFailure;
      },
    });
    await expect(workerService.ready()).rejects.toBe(inferenceFailure);
    const stopping = workerService.stop();
    const settled = vi.fn();
    void stopping.then(settled, settled);
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [inferenceFailure, artifactFailure],
    });
    try {
      await Promise.race([tunnelEntered.promise, stopping]);
      expect(settled).not.toHaveBeenCalled();
      tunnelClosed.resolve();
      await Promise.race([artifactEntered.promise, stopping]);
      expect(settled).not.toHaveBeenCalled();
      artifactClosed.resolve();
      await rejected;
    } finally {
      tunnelClosed.resolve();
      artifactClosed.resolve();
      await stopping.catch(() => undefined);
      support.testState.service = undefined;
    }
  });

  it("joins both readiness owners before reporting their original failures", async () => {
    const storeFailure = new Error("environment inventory readiness failed");
    const inferenceFailure = new Error("inference recovery failed");
    const storeReady = createDeferred();
    const inferenceReady = createDeferred();
    vi.spyOn(support.testState.store, "ready").mockReturnValueOnce(storeReady.promise);
    const inferenceStore = createWorkerInferenceStore({ path: support.testState.stateDb.path });
    vi.spyOn(inferenceStore, "recoverPending").mockReturnValueOnce(inferenceReady.promise);
    const workerService = support.createService(support.createProvider(), { inferenceStore });
    const ready = workerService.ready();
    const settled = vi.fn();
    void ready.then(settled, settled);
    try {
      inferenceReady.reject(inferenceFailure);
      await Promise.allSettled([inferenceReady.promise]);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      storeReady.reject(storeFailure);
      await expect(ready).rejects.toMatchObject({ errors: [storeFailure, inferenceFailure] });
    } finally {
      inferenceReady.reject(inferenceFailure);
      storeReady.reject(storeFailure);
      await ready.catch(() => undefined);
      await workerService.stop().catch(() => undefined);
      support.testState.service = undefined;
    }
  });

  it("projects live workspace transport status and fences it before provider teardown", async () => {
    await support.seedReady("worker-tunnel", undefined, true);
    const order: string[] = [];
    let tunnelStatus: "stopped" | "connected" = "stopped";
    const tunnelManager = {
      status: () => tunnelStatus,
      start: vi.fn(async (request) => {
        tunnelStatus = "connected";
        return {
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          runWorkspaceCommand: vi.fn(),
          syncWorkspace: vi.fn(),
          stop: async () => {},
        };
      }),
      stop: vi.fn(async () => {
        tunnelStatus = "stopped";
        order.push("tunnel-stop");
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = support.createService(provider, { tunnelManager });

    await expect(
      workerService.startTunnel({ environmentId: "worker-tunnel", ownerEpoch: 0 }),
    ).rejects.toThrow("owner credential is not current");
    expect(tunnelManager.start).not.toHaveBeenCalled();

    await workerService.startTunnel({
      environmentId: "worker-tunnel",
      ownerEpoch: 1,
    });
    expect(tunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleHash: support.BUNDLE_HASH,
        sharedHost: true,
      }),
    );
    expect(workerService.get("worker-tunnel")).toMatchObject({ tunnelStatus: "connected" });

    support.testState.nowMs += 20_000;
    await expect(
      workerService.startTunnel({ environmentId: "worker-tunnel", ownerEpoch: 1 }),
    ).resolves.toMatchObject({ environmentId: "worker-tunnel", ownerEpoch: 1 });
    expect(tunnelManager.start).toHaveBeenCalledTimes(2);

    await support.testState.store.revokeEnvironmentCredential("worker-tunnel");
    await expect(
      workerService.startTunnel({ environmentId: "worker-tunnel", ownerEpoch: 1 }),
    ).rejects.toThrow("owner credential is not current");
    expect(tunnelManager.start).toHaveBeenCalledTimes(2);

    await workerService.destroy("worker-tunnel");
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
    expect(workerService.get("worker-tunnel")).toMatchObject({
      state: "destroyed",
      tunnelStatus: "stopped",
    });
  });

  it.each([
    ["stale receipt", { ...support.BOOTSTRAP_RECEIPT, bundleHash: "c".repeat(64) }, undefined],
    ["unavailable current bundle", support.BOOTSTRAP_RECEIPT, new Error("bundle unavailable")],
  ] as const)("rejects SSH tunnel startup with %s", async (_name, receipt, prepareError) => {
    const environmentId = "worker-tunnel-current-bundle";
    const bootstrapping = await support.seedBootstrapping(environmentId, undefined, true);
    await support.testState.store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(environmentId, receipt),
    });
    if (prepareError) {
      support.testState.prepareInstallation = vi.fn(async () => {
        throw prepareError;
      });
    }
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(workerService.startTunnel({ environmentId, ownerEpoch: 1 })).rejects.toMatchObject(
      {
        code: "invalid_state",
        message: prepareError
          ? "Current worker build identity is unavailable"
          : STALE_WORKER_BUILD_REASON,
      } satisfies Partial<WorkerEnvironmentServiceError>,
    );
    expect(tunnelManager.start).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "revokes unopened desktop tickets across disable and re-enable (initially enabled: %s)",
    async (initiallyEnabled) => {
      support.testState.nowMs = Date.now();
      const record = await support.seedReadyDesktop("worker-desktop-old-ticket");
      const tunnelManager = createWorkerTunnelManager();
      vi.spyOn(tunnelManager.desktop, "acquire").mockResolvedValue({
        attachment: { kind: "unix-socket", socketPath: "/tmp/worker-desktop.sock" },
      });
      support.testState.config.cloudWorkers!.desktop = initiallyEnabled;
      const workerService = support.createService(support.createProvider(), { tunnelManager });
      // Config publication can admit a request before its policy reconciliation runs.
      support.testState.config.cloudWorkers!.desktop = true;
      const observed = await workerService.observeDesktop({
        environmentId: record.environmentId,
        control: false,
      });
      await workerService.reconcileDesktopPolicy();
      support.testState.config.cloudWorkers!.desktop = false;
      await workerService.reconcileDesktopPolicy();
      support.testState.config.cloudWorkers!.desktop = true;
      await workerService.reconcileDesktopPolicy();
      expect(observed.expiresAtMs).toBeGreaterThan(Date.now());

      const registry = { attachObserver: vi.fn(), claimStream: vi.fn() };
      const server = createServer();
      server.on("upgrade", (request, socket, head) => {
        observeBridge.handleDesktopObserveUpgrade(request, socket, head, { registry });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected desktop observer server address");
      }
      const observer = new WebSocket(`ws://127.0.0.1:${address.port}${observed.wsPath}`);
      try {
        await new Promise<void>((resolve, reject) => {
          observer.once("open", () => reject(new Error("Retired desktop ticket was accepted")));
          observer.once("unexpected-response", (_request, response) => {
            response.resume();
            if (response.statusCode === 401) {
              resolve();
            } else {
              reject(new Error(`Expected revoked ticket rejection, got ${response.statusCode}`));
            }
          });
          observer.once("error", () => undefined);
        });
        expect(registry.attachObserver).not.toHaveBeenCalled();
      } finally {
        observer.terminate();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  it("stops the node transport that owns a timed-out start", async () => {
    support.testState.config.cloudWorkers!.profiles!.development!.provider = "device";
    support.testState.config.cloudWorkers!.profiles!.development!.settings = {
      device: "device-1",
    };
    const { promise: started, resolve: signalStarted } = createDeferred();
    const pendingStart = new Promise<never>(() => {});
    const sshStop = vi.fn(async () => {});
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: sshStop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const nodeTunnelManager = {
      status: () => "connecting" as const,
      start: vi.fn(() => {
        signalStarted();
        return pendingStart;
      }),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    };
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        id: "device",
        provision: async () => ({
          leaseId: "device-lease",
          node: { deviceId: "device-1" },
        }),
      }),
      {
        tunnelManager,
        nodeTunnelManager,
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      },
    );
    const environment = await workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "device-tunnel-timeout",
    });
    const credential = await workerService.attachSession({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      sessionId: "session-device",
    });
    const sshStopCallsBeforeStart = sshStop.mock.calls.length;
    // Keep the monotonic clock shared with real SQLite workers on its native epoch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const starting = workerService.startTunnel({
      environmentId: environment.environmentId,
      ownerEpoch: credential.ownerEpoch,
    });
    const rejected = expect(starting).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("check that the worker is online and reachable, then retry"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await started;
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await rejected;
    expect(nodeTunnelManager.stop).toHaveBeenCalledWith(
      environment.environmentId,
      credential.ownerEpoch,
    );
    expect(sshStop).toHaveBeenCalledTimes(sshStopCallsBeforeStart);
  });

  it("reconciles shared-host isolation for a persisted lease before tunnel startup", async () => {
    await support.seedReady("worker-legacy-shared");
    support.testState.stateDb.db
      .prepare("UPDATE worker_environments SET shared_host = NULL WHERE environment_id = ?")
      .run("worker-legacy-shared");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = await createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(async (request: Parameters<WorkerTunnelManager["start"]>[0]) => ({
        environmentId: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        measureLaunchTurn,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        syncWorkspace: vi.fn(),
        stop: async () => {},
      })),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    let inspectionFails = true;
    const provider = support.createProvider({
      inspect: async () => {
        if (inspectionFails) {
          throw new Error("provider unavailable");
        }
        return { status: "active", sharedHost: true };
      },
    });
    const workerService = support.createService(provider, { tunnelManager });

    expect(support.testState.store.get("worker-legacy-shared")?.sharedHost).toBeNull();
    await workerService.reconcileOnce();
    await expect(
      workerService.startTunnel({ environmentId: "worker-legacy-shared", ownerEpoch: 1 }),
    ).rejects.toThrow("isolation is not reconciled");
    expect(tunnelManager.start).not.toHaveBeenCalled();
    inspectionFails = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.get("worker-legacy-shared")?.sharedHost).toBe(true);
    await workerService.startTunnel({ environmentId: "worker-legacy-shared", ownerEpoch: 1 });
    expect(tunnelManager.start).toHaveBeenCalledWith(expect.objectContaining({ sharedHost: true }));
  });

  it("fences an existing tunnel before changing its shared-host isolation", async () => {
    await support.seedReady("worker-isolation-change");
    const stop = vi.fn(async (_environmentId: string, _ownerEpoch?: number) => {
      expect(support.testState.store.get("worker-isolation-change")?.sharedHost).toBe(false);
    });
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      inspect: async () => ({ status: "active", sharedHost: true }),
    });

    await support.createService(provider, { tunnelManager }).reconcileOnce();

    expect(stop.mock.calls[0]?.[0]).toBe("worker-isolation-change");
    expect(support.testState.store.get("worker-isolation-change")?.sharedHost).toBe(true);
  });

  it("projects desktop availability only while a desktop lease is observable", async () => {
    const ready = await support.seedReadyDesktop("worker-desktop-projection");
    const workerService = support.createService(support.createProvider());
    expect(workerService.get(ready.environmentId)).toMatchObject({
      desktopAvailable: true,
      desktopApps: ["browser", "terminal"],
    });
    await support.testState.store.transition({
      environmentId: ready.environmentId,
      from: ready.state,
      to: "draining",
    });
    expect(workerService.get(ready.environmentId)).toMatchObject({
      desktopAvailable: false,
      desktopApps: [],
    });
  });

  it("launches only an advertised desktop app through the pinned SSH runtime", async () => {
    const record = await support.seedReadyDesktop("worker-desktop-launch");
    const launchApp = vi.fn(async () => {});
    const tunnelManager = {
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        launchApp,
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(
      workerService.launchDesktopApp({ environmentId: record.environmentId, app: "browser" }),
    ).resolves.toEqual({ app: "browser", status: "ready" });
    expect(launchApp).toHaveBeenCalledExactlyOnceWith({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      ssh: support.SSH_ENDPOINT,
      app: support.DESKTOP.apps?.[0],
      resolveIdentity: expect.any(Function),
    });
  });

  it("rejects missing desktop apps and maps launcher runtime failures to typed errors", async () => {
    const record = await support.seedReadyDesktop("worker-desktop-launch-errors");
    const launchApp = vi.fn(async () => {
      throw new Error("private SSH launcher detail");
    });
    const tunnelManager = {
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        launchApp,
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(
      workerService.launchDesktopApp({ environmentId: record.environmentId, app: "browser" }),
    ).rejects.toMatchObject({
      code: "launcher_failure",
      message: "worker desktop browser launcher failed; verify the app is installed and retry",
    });
    await support.testState.store.transition({
      environmentId: record.environmentId,
      from: record.state,
      to: "draining",
    });
    await expect(
      workerService.launchDesktopApp({ environmentId: record.environmentId, app: "terminal" }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    const browserOnly = await support.seedReadyDesktop("worker-desktop-browser-only", {
      ...support.DESKTOP,
      apps: [support.DESKTOP.apps![0]!],
    });
    await expect(
      workerService.launchDesktopApp({
        environmentId: browserOnly.environmentId,
        app: "terminal",
      }),
    ).rejects.toMatchObject({
      code: "desktop_app_not_found",
      message: "environment does not advertise desktop app: terminal",
    });
  });

  it.each([true, false, undefined])(
    "carries provider resize permission %s through SSH observe",
    async (allowsDesktopResize) => {
      const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
      const client = { invalidated: false };
      const requester = {
        signal: new AbortController().signal,
        isCurrent: () => !client.invalidated,
      };
      const record = await support.seedReadyDesktop("worker-desktop-observe");
      const desktopPassword = ["desktop", String.fromCharCode(45), "secret"].join("");
      const acquire = vi.fn(async () => ({
        attachment: { kind: "unix-socket" as const, socketPath: "/tmp/worker-desktop.sock" },
        vncPassword: desktopPassword,
      }));
      const tunnelManager = {
        desktop: {
          acquire,
          attachObserver: vi.fn(),
          stop: vi.fn(async () => {}),
          stopAll: vi.fn(async () => {}),
        },
        status: () => "stopped" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const workerService = support.createService(support.createProvider({ allowsDesktopResize }), {
        tunnelManager,
      });

      const observed = await workerService.observeDesktop({
        environmentId: record.environmentId,
        control: true,
        requester,
      });
      expect(observed).toMatchObject({
        transport: "rfb",
        wsPath: expect.stringMatching(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u),
        expiresAtMs: support.testState.nowMs + 60_000,
        control: true,
        vncPassword: desktopPassword,
      });
      expect(observed.canResize).toBe(allowsDesktopResize === true ? true : undefined);
      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          desktop: support.DESKTOP,
          ssh: support.SSH_ENDPOINT,
          resolveIdentity: expect.any(Function),
        }),
      );
      const mintedRequester = mint.mock.calls[0]?.[0].requester;
      expect(mintedRequester?.isCurrent()).toBe(true);
      client.invalidated = true;
      expect(mintedRequester?.isCurrent()).toBe(false);
      expect(requester.signal.aborted).toBe(false);
    },
  );

  it.each([
    { allowsDesktopResize: true, allowsResize: undefined },
    { allowsDesktopResize: false, allowsResize: undefined },
    { allowsDesktopResize: undefined, allowsResize: undefined },
    { allowsDesktopResize: true, allowsResize: false },
    { allowsDesktopResize: false, allowsResize: true },
  ])(
    "carries provider $allowsDesktopResize and endpoint $allowsResize resize permission through node observe",
    async ({ allowsDesktopResize, allowsResize }) => {
      const requester = { signal: new AbortController().signal, isCurrent: () => true };
      const desktop = {
        ...support.DESKTOP,
        ...(allowsResize === undefined ? {} : { allowsResize }),
      };
      const record = await support.seedReadyNodeDesktop("worker-node-desktop-access", desktop);
      const order: string[] = [];
      const observe = vi.fn(async () => ({
        transport: "rfb" as const,
        wsPath: "/desktop/observe?token=node-carrier",
        expiresAtMs: support.testState.nowMs + 60_000,
        control: true,
      }));
      const launchApp = vi.fn(async () => {});
      const stop = vi.fn(async () => {
        order.push("node-desktop-stop");
      });
      const nodeDesktopCarrier = {
        bindRuntime: vi.fn(),
        observe,
        launchApp,
        stop,
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerNodeDesktopCarrier;
      const workerService = support.createService(
        support.createProvider({
          allowsDesktopResize,
          destroy: async () => {
            order.push("provider-destroy");
          },
        }),
        { nodeDesktopCarrier },
      );
      expect(workerService.get(record.environmentId)).toMatchObject({
        desktopAvailable: true,
        desktopApps: ["browser", "terminal"],
      });

      await expect(
        workerService.observeDesktop({
          environmentId: record.environmentId,
          control: true,
          requester,
        }),
      ).resolves.toEqual({
        transport: "rfb",
        wsPath: "/desktop/observe?token=node-carrier",
        expiresAtMs: support.testState.nowMs + 60_000,
        control: true,
        ...(allowsDesktopResize === true && allowsResize !== false ? { canResize: true } : {}),
      });
      expect(observe).toHaveBeenCalledWith({
        record: expect.objectContaining({
          environmentId: record.environmentId,
          nodeDeviceId: record.nodeDeviceId,
          sshEndpoint: null,
          desktop,
        }),
        control: true,
        requester: expect.objectContaining({
          signal: expect.any(AbortSignal),
          isCurrent: expect.any(Function),
        }),
      });

      await expect(
        workerService.launchDesktopApp({ environmentId: record.environmentId, app: "browser" }),
      ).resolves.toEqual({ app: "browser", status: "ready" });
      expect(launchApp).toHaveBeenCalledWith({
        record: expect.objectContaining({ environmentId: record.environmentId }),
        app: support.DESKTOP.apps![0],
      });

      await workerService.destroy(record.environmentId);
      expect(order).toEqual(["node-desktop-stop", "provider-destroy"]);
    },
  );

  it("preserves node observation without the provisioning provider and omits resize permission", async () => {
    const record = await support.seedReadyNodeDesktop("worker-node-provider-unavailable");
    const observe = vi.fn(async () => ({
      transport: "rfb" as const,
      wsPath: "/desktop/observe?token=node-carrier",
      expiresAtMs: support.testState.nowMs + 60_000,
      control: true,
    }));
    const nodeDesktopCarrier = {
      observe,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerNodeDesktopCarrier;
    const workerService = support.createService(
      support.createProvider({ allowsDesktopResize: true }),
      { nodeDesktopCarrier },
    );
    support.testState.providersEnabled = false;

    await expect(
      workerService.observeDesktop({ environmentId: record.environmentId, control: true }),
    ).resolves.toEqual({
      transport: "rfb",
      wsPath: "/desktop/observe?token=node-carrier",
      expiresAtMs: support.testState.nowMs + 60_000,
      control: true,
    });
    expect(observe).toHaveBeenCalledOnce();
  });

  it("rejects desktop observe for invalid lifecycle gates and a stopped service", async () => {
    const tunnelManager = {
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });
    const requested = await support.testState.store.createIntent({
      environmentId: "worker-desktop-requested",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:worker-desktop-requested",
    });
    await support.seedReady("worker-desktop-missing");
    const destroying = await support.seedReadyDesktop("worker-desktop-destroy-requested");
    await support.testState.store.requestDestroy({
      environmentId: destroying.environmentId,
      state: destroying.state,
    });

    support.testState.config.cloudWorkers!.desktop = false;
    await expect(
      workerService.observeDesktop({ environmentId: requested.environmentId, control: false }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message:
        "worker desktop observe is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)",
    });
    support.testState.config.cloudWorkers!.desktop = true;

    for (const environmentId of [
      requested.environmentId,
      "worker-desktop-missing",
      destroying.environmentId,
    ]) {
      await expect(
        workerService.observeDesktop({ environmentId, control: false }),
      ).rejects.toMatchObject({
        code: "invalid_state",
        message: "environment has no desktop; desktop is a warm-time capability of the profile",
      });
    }
    await expect(
      workerService.observeDesktop({ environmentId: "worker-desktop-unknown", control: false }),
    ).rejects.toMatchObject({ code: "environment_not_found" });
    await workerService.stop();
    await expect(
      workerService.observeDesktop({ environmentId: destroying.environmentId, control: false }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message: "Worker environment service is stopping",
    });
    expect(tunnelManager.desktop.acquire).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "observe", reenable: false },
    { operation: "launch", reenable: false },
    { operation: "observe", reenable: true },
    { operation: "launch", reenable: true },
  ] as const)(
    "rejects desktop $operation results after disabling the lab during startup (reenable: $reenable)",
    async ({ operation, reenable }) => {
      const record = await support.seedReadyDesktop(`worker-desktop-policy-${operation}`);
      const startup = createDeferred();
      const tunnelManager = createWorkerTunnelManager();
      const acquire = vi.spyOn(tunnelManager.desktop, "acquire").mockImplementation(async () => {
        await startup.promise;
        return {
          attachment: { kind: "unix-socket" as const, socketPath: "/tmp/worker-desktop.sock" },
        };
      });
      const launchApp = vi
        .spyOn(tunnelManager.desktop, "launchApp")
        .mockImplementation(async () => await startup.promise);
      const workerService = support.createService(support.createProvider(), { tunnelManager });
      const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
      const pending =
        operation === "observe"
          ? workerService.observeDesktop({ environmentId: record.environmentId, control: false })
          : workerService.launchDesktopApp({ environmentId: record.environmentId, app: "browser" });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "invalid_state",
        message: reenable
          ? "Worker desktop policy changed; retry the request"
          : expect.stringContaining(`worker desktop ${operation} is disabled`),
      });
      try {
        await support.waitForFast(() =>
          expect(operation === "observe" ? acquire : launchApp).toHaveBeenCalledOnce(),
        );
        support.testState.config.cloudWorkers!.desktop = false;
        if (reenable) {
          await workerService.reconcileDesktopPolicy();
          support.testState.config.cloudWorkers!.desktop = true;
          await workerService.reconcileDesktopPolicy();
        }
        startup.resolve();
        await rejected;
        expect(mint).not.toHaveBeenCalled();
      } finally {
        startup.resolve();
      }
    },
  );

  it("fences a draining tunnel before reporting an unavailable provider", async () => {
    await support.seedReady("worker-provider-missing");
    const stop = vi.fn(async (_environmentId: string, _ownerEpoch?: number) => {});
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });
    support.testState.providersEnabled = false;

    await expect(workerService.destroy("worker-provider-missing")).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(stop.mock.calls[0]?.[0]).toBe("worker-provider-missing");
    expect(support.testState.store.get("worker-provider-missing")).toMatchObject({
      state: "draining",
      destroyRequestedAtMs: expect.any(Number),
    });
  });

  it("does not hold the environment lock while a tunnel is connecting", async () => {
    await support.seedReady("worker-tunnel-pending");
    const { promise: pendingStart, reject: rejectStart } = createDeferred<never>();
    const order: string[] = [];
    const tunnelManager = {
      status: () => "connecting" as const,
      start: vi.fn(() => pendingStart),
      stop: vi.fn(async () => {
        order.push("tunnel-stop");
        rejectStart?.(new Error("tunnel stopped"));
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = support.createService(provider, { tunnelManager });

    const starting = workerService.startTunnel({
      environmentId: "worker-tunnel-pending",
      ownerEpoch: 1,
    });
    const rejectedStart = expect(starting).rejects.toThrow("tunnel stopped");
    await support.waitForFast(() => expect(tunnelManager.start).toHaveBeenCalledOnce());

    await workerService.destroy("worker-tunnel-pending");

    await rejectedStart;
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
  });

  it("stops a poisoned tunnel start and returns a typed deadline error", async () => {
    await support.seedReady("worker-tunnel-timeout");
    // Keep the monotonic clock shared with real SQLite workers on its native epoch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { promise: started, resolve: signalStarted } = createDeferred();
    const { promise: pendingStart, reject: rejectStart } = createDeferred<never>();
    const tunnelManager = {
      status: () => "connecting" as const,
      start: vi.fn(() => {
        signalStarted();
        return pendingStart;
      }),
      stop: vi.fn(async () => {
        rejectStart(new Error("tunnel stopped"));
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    const starting = workerService.startTunnel({
      environmentId: "worker-tunnel-timeout",
      ownerEpoch: 1,
    });
    const rejected = expect(starting).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("check that the worker is online and reachable, then retry"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await started;
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await rejected;
    expect(tunnelManager.stop).toHaveBeenCalledWith("worker-tunnel-timeout", 1);
  });
});
