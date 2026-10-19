import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { setActiveNodeContexts } from "../infra/active-node-context.js";
import { NODE_WORKER_PORTAL_STREAM_VERSION } from "../infra/node-runner-inventory.js";
import * as workspaceCommands from "../node-host/node-worker-workspace-commands.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import type { WorkerProvider } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createNodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "./node-registry-private.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { withPreparedNodeAcknowledgement } from "./server-worker-environment-startup.prepared.test-support.js";
import {
  createWorkerStartupRuntime,
  createReadyStartupWorker,
  workerStartupCredential,
} from "./server-worker-environment-startup.runtime.test-support.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";
import {
  DEVICE_WORKER_PROVIDER_ID,
  reconcileDeviceWorker,
} from "./worker-environments/device-provider.js";
import { createWorkerInferenceStore } from "./worker-environments/inference-store.js";
import { createNodeWorkerBundleTestNode } from "./worker-environments/node-worker-bundle.test-support.js";
import * as workerServices from "./worker-environments/service.js";

const DEVICE_ID = "revoked-device";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setActiveNodeContexts([]);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    cleanup();
  }),
);
const preparedRoot = (label: string) => fs.realpath(tempDirs.make(`openclaw-prepared-${label}-`));

it.each([false, true])(
  "retires failed startup subscriptions and transfer scratch (cleanup failure=%s)",
  async (cleanupFails) => {
    const stateDir = tempDirs.make("openclaw-worker-readiness-failure-");
    const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
    const readinessFailure = new Error("inference recovery failed");
    const cleanupFailure = new Error("bootstrap artifact cleanup failed");
    await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const activeSubscriptions = new Set<() => void>();
      const register = startup.placementStore.registerTurnClaimClosedHandler.bind(
        startup.placementStore,
      );
      const registerSpy = vi
        .spyOn(startup.placementStore, "registerTurnClaimClosedHandler")
        .mockImplementation((handler) => {
          const unsubscribe = register(handler);
          activeSubscriptions.add(unsubscribe);
          return () => {
            unsubscribe();
            activeSubscriptions.delete(unsubscribe);
          };
        });
      const createService = workerServices.createWorkerEnvironmentService;
      let service: ReturnType<typeof createService> | undefined;
      vi.spyOn(workerServices, "createWorkerEnvironmentService").mockImplementation((options) => {
        const inferenceStore = createWorkerInferenceStore();
        vi.spyOn(inferenceStore, "recoverPending").mockRejectedValue(readinessFailure);
        service = createService({
          ...options,
          inferenceStore,
          closeNodeBootstrapArtifacts: async () => {
            await options.closeNodeBootstrapArtifacts?.();
            if (cleanupFails) {
              throw cleanupFailure;
            }
          },
        });
        return service;
      });
      const registry = createEmptyPluginRegistry();
      const creating = createWorkerStartupRuntime(startup, () => registry);
      try {
        if (cleanupFails) {
          await expect(creating).rejects.toMatchObject({
            errors: [readinessFailure, cleanupFailure],
          });
        } else {
          await expect(creating).rejects.toBe(readinessFailure);
        }
        expect(registerSpy).toHaveBeenCalled();
        expect(activeSubscriptions.size).toBe(0);
        await expect(fs.stat(transferRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await service?.stop().catch(() => undefined);
      }
    });
  },
);

it("cleans transfer scratch before serving and removes it on shutdown", async () => {
  const stateDir = tempDirs.make("openclaw-worker-transfer-startup-");
  const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
  const staleRoot = path.join(transferRoot, "context-stale");
  await fs.mkdir(staleRoot, { recursive: true });
  await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");

  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    const registry = createEmptyPluginRegistry();
    const runtime = await createWorkerStartupRuntime(startup, () => registry);
    const service = runtime.workerEnvironmentService;
    if (!service) {
      throw new Error("worker environment service was not created");
    }
    try {
      await expect(fs.readdir(transferRoot)).resolves.toEqual([]);
    } finally {
      await service.stop();
    }
    await expect(fs.stat(transferRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("composes idle provider maintenance and drains it during shutdown", async () => {
  const providerId = "maintenance-provider";
  const stateDir = tempDirs.make("openclaw-worker-maintenance-startup-");
  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    type MaintenanceContext = Parameters<NonNullable<WorkerProvider["maintain"]>>[0];
    const entered = createDeferredCore<MaintenanceContext>();
    const aborted = createDeferredCore();
    const finish = createDeferredCore();
    const maintain = vi.fn(async (context: MaintenanceContext) => {
      context.assertCurrent();
      context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve(context);
      await finish.promise;
    });
    const registry = createEmptyPluginRegistry();
    const owner = createPluginRecord({
      id: "maintenance-owner",
      source: "/synthetic/maintenance-owner/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
      contracts: { workerProviders: [providerId] },
    });
    registry.plugins.push(owner);
    registry.workerProviders.set(providerId, {
      pluginId: owner.id,
      source: owner.source,
      provider: {
        id: providerId,
        maintain,
        resolveAllocation: async () => ({ leaseId: "unused", sharedHost: false }),
        provision: async () => {
          throw new Error("unused");
        },
        inspect: async () => ({ status: "unknown" }),
        destroy: async () => {},
      },
    });
    markPluginRegistryActive(registry);
    setRuntimeConfigSnapshot({
      cloudWorkers: {
        profiles: { project: { provider: providerId, settings: { location: "one" } } },
      },
    });
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    const runtime = await createWorkerStartupRuntime(startup, () => registry);
    const service = runtime.workerEnvironmentService;
    assert(service, "worker environment service was not created");
    let stopping: Promise<void> | undefined;
    const stopped = vi.fn();
    try {
      expect(startup.store.list()).toEqual([]);
      const reconciliation = service.reconcileOnce();
      const context = await entered.promise;
      await reconciliation;
      expect(maintain).toHaveBeenCalledOnce();
      expect(context.profiles).toEqual([{ location: "one" }]);
      stopping = service.stop().then(stopped);
      await aborted.promise;
      expect(stopped).not.toHaveBeenCalled();
      expect(() => context.assertCurrent()).toThrow();
    } finally {
      finish.resolve();
      await (stopping ?? service.stop());
    }
    expect(stopped).toHaveBeenCalledOnce();
  });
});

it("binds device revocation to the persisted profile settings", async () => {
  const stateDir = tempDirs.make("openclaw-worker-startup-");
  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    await createReadyStartupWorker(startup, {
      environmentId: "device-environment",
      providerId: DEVICE_WORKER_PROVIDER_ID,
      profileId: `device:${DEVICE_ID}`,
      profileSnapshot: { install: "bundle", settings: { device: DEVICE_ID } },
      ready: {
        leaseId: "device-lease",
        nodeDeviceId: DEVICE_ID,
        credential: workerStartupCredential("device-credential"),
      },
    });

    const registry = createEmptyPluginRegistry();
    const runtime = await createWorkerStartupRuntime(startup, () => registry);
    const service = runtime.workerEnvironmentService;
    assert(service, "worker environment service was not created");
    try {
      await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([
        "device-environment",
      ]);
      expect(startup.store.getCredential("device-environment")).toBeUndefined();
      expect(startup.store.get("device-environment")).toMatchObject({
        state: "failed",
        leaseId: null,
        nodeDeviceId: null,
        attachedSessionIds: [],
        destroyRequestedAtMs: expect.any(Number),
        teardownTerminalState: "failed",
        lastError: "Worker provider no longer recognizes the lease",
      });
    } finally {
      await service.stop();
    }
  });
});

it("composes node desktop control into the worker environment runtime", async () => {
  const stateDir = tempDirs.make("openclaw-worker-node-desktop-startup-");
  await withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
    setRuntimeConfigSnapshot({ cloudWorkers: { desktop: true } });
    const startup = await loadGatewayWorkerEnvironmentStartupState();
    const nodeId = "node-desktop-device";
    const app = { id: "terminal" as const, executablePath: "/usr/bin/true" };
    const record = await createReadyStartupWorker(startup, {
      environmentId: "node-desktop-environment",
      providerId: "fake-provider",
      profileId: "desktop-profile",
      profileSnapshot: { settings: { desktop: true } },
      ready: {
        leaseId: "node-desktop-lease",
        nodeDeviceId: nodeId,
        desktop: { protocol: "rfb", port: 5900, apps: [app] },
        credential: workerStartupCredential("node-desktop-credential"),
      },
    });
    const proof: NodeWorkerSupervisorNodeProof = {
      ...createNodeWorkerBundleTestNode(),
      nodeId,
      workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    };
    const transport: NodeWorkerSupervisorTransport = {
      getCurrentNode: async (candidateNodeId) =>
        proof.nodeId === candidateNodeId ? proof : undefined,
      listCurrentNodes: async () => [proof],
      hasCurrentRunner: (candidateNodeId) => candidateNodeId === proof.nodeId,
      isCurrent: () => true,
      invoke: async (request) => {
        expect(request.isDispatchAuthorized()).toBe(true);
        return { ok: true, payloadJSON: '{"status":"ready"}' };
      },
    };
    const registry = createEmptyPluginRegistry();
    const runtime = await createWorkerStartupRuntime(startup, () => registry, {
      nodeDesktopStreamBroker: createNodeDesktopStreamBroker(),
    });
    const service = runtime.workerEnvironmentService;
    try {
      assert(
        service && runtime.bindWorkerNodeDesktopControl,
        "worker node desktop runtime was not composed",
      );
      runtime.bindWorkerNodeDesktopControl(transport);
      const portalSupported = () =>
        service.supportsNodePortal(record.environmentId, record.ownerEpoch);
      await expect(portalSupported()).resolves.toBe(false);
      runtime.bindDeviceNodeControl?.(transport);
      await expect(portalSupported()).resolves.toBe(false);
      proof.workerHost.portalStream = NODE_WORKER_PORTAL_STREAM_VERSION;
      await expect(portalSupported()).resolves.toBe(true);
      delete proof.workerHost.portalStream;
      await expect(portalSupported()).resolves.toBe(false);
      await expect(
        service.launchDesktopApp({ environmentId: record.environmentId, app: "terminal" }),
      ).resolves.toEqual({ app: "terminal", status: "ready" });
    } finally {
      await service?.stop();
    }
  });
});
it.each([false, true])(
  "verifies the actual checkout before adopting it (source changed: %s)",
  async (changed) => {
    await withPreparedNodeAcknowledgement(await preparedRoot("ack"), async (f) => {
      if (changed) {
        await fs.writeFile(path.join(f.prepared.workspaceDir, "source.txt"), "changed source\n");
        await expect(f.register()).rejects.toThrow("source does not match its manifest");
        expect(await f.preparedStore.find(f.record.environmentId)).toBeUndefined();
        return;
      }
      await f.register();
      await f.attach();
      await f.bind();
      expect(f.received.map((response) => response.ok)).toEqual([true, true]);
      const acquired = await f.workspace.acquireManagedWorkspaceAsync({
        ...f.binding,
        workspaceDir: f.prepared.workspaceDir,
      });
      try {
        expect(acquired.homeDir).toBe(f.prepared.homeDir);
        expect(await fs.readFile(path.join(f.prepared.workspaceDir, "source.txt"), "utf8")).toBe(
          "pristine source\n",
        );
      } finally {
        acquired.release();
      }
    });
  },
);

it.each([
  ["register", "capability"],
  ["register", "owner"],
  ["register", "pairing"],
  ["bind", "capability"],
  ["bind", "owner"],
  ["bind", "pairing"],
  ["bind", "placement"],
] as const)("fences %s when %s changes during pairing", async (action, loss) => {
  await withPreparedNodeAcknowledgement(await preparedRoot("owner"), async (f) => {
    if (action === "bind") {
      await f.register();
      await f.attach();
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let lookup = 0;
    // Hold the invoke's lookup after node enumeration captured the original proof.
    f.holdPairing(async () => {
      if (++lookup === 2) {
        entered.resolve();
        await release.promise;
      }
    });
    const invokedBefore = f.invoked.length;
    const operation = f[action]().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      if (loss === "capability") {
        f.setPreparedWorkspace(false);
      } else if (loss === "owner") {
        if (action === "register") {
          await f.startup.store.requestDestroy({
            environmentId: f.record.environmentId,
            state: "provisioning",
          });
        } else {
          await f.startup.store.revokeEnvironmentCredential(f.record.environmentId);
        }
      } else if (loss === "placement") {
        const placement = f.startup.placementStore.get(f.binding.sessionId)!;
        await f.startup.placementStore.transition({
          sessionId: f.binding.sessionId,
          from: "syncing",
          to: "starting",
          expectedGeneration: placement.generation,
          patch: {
            workspaceBaseManifestRef: f.prepared.sourceManifestRef,
            remoteWorkspaceDir: f.prepared.workspaceDir,
          },
        });
      } else {
        f.revokePairing();
      }
      release.resolve();
      expect(await operation).toBeInstanceOf(Error);
      expect(f.invoked).toHaveLength(invokedBefore);
      const registration = await f.preparedStore.find(f.record.environmentId);
      if (action === "bind") {
        expect(registration).toMatchObject({ session_id: null, bound_at_ms: null });
      } else {
        expect(registration).toBeUndefined();
      }
    } finally {
      release.resolve();
      await operation;
    }
  });
});

it("cancels a register before its node commits after the caller aborts", async () => {
  await withPreparedNodeAcknowledgement(await preparedRoot("abort"), async (f) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const capture = workspaceCommands.captureManifest;
    vi.spyOn(workspaceCommands, "captureManifest").mockImplementation(async (params) => {
      const result = await capture(params);
      entered.resolve();
      await release.promise;
      return result;
    });
    const caller = new AbortController();
    const registering = f.register(caller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      caller.abort();
      expect(await registering).toBeInstanceOf(Error);
      await f.cancelled.promise;
      release.resolve();
      await f.settleInvokes();
      expect(await f.preparedStore.find(f.record.environmentId)).toBeUndefined();
    } finally {
      caller.abort();
      release.resolve();
      await registering;
      await f.settleInvokes();
    }
  });
});
