import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { setActiveNodeContext } from "../infra/active-node-context.js";
import {
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import * as workspaceCommands from "../node-host/node-worker-workspace-commands.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import type { WorkerProvider } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createNodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "./node-registry-private.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { withPreparedNodeAcknowledgement } from "./server-worker-environment-startup.prepared.test-support.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import {
  DEVICE_WORKER_PROVIDER_ID,
  reconcileDeviceWorker,
} from "./worker-environments/device-provider.js";

const DEVICE_ID = "revoked-device";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setActiveNodeContext(null);
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
});

describe("gateway worker environment startup", () => {
  it("cleans transfer scratch before serving and removes it on shutdown", async () => {
    const stateDir = tempDirs.make("openclaw-worker-transfer-startup-");
    const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
    const staleRoot = path.join(transferRoot, "context-stale");
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const registry = createEmptyPluginRegistry();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
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
    const stateDir = tempDirs.make("openclaw-worker-maintenance-startup-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
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
        contracts: { workerProviders: ["maintenance-provider"] },
      });
      registry.plugins.push(owner);
      registry.workerProviders.set("maintenance-provider", {
        pluginId: owner.id,
        source: owner.source,
        provider: {
          id: "maintenance-provider",
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
          profiles: {
            project: { provider: "maintenance-provider", settings: { location: "one" } },
          },
        },
      });
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service) {
        throw new Error("worker environment service was not created");
      }
      let stopping: Promise<void> | undefined;
      let stopped = false;
      try {
        expect(startup.store.list()).toEqual([]);
        const reconciliation = service.reconcileOnce();
        const context = await entered.promise;
        await reconciliation;
        expect(maintain).toHaveBeenCalledOnce();
        expect(context.profiles).toEqual([{ location: "one" }]);
        stopping = service.stop().then(() => {
          stopped = true;
        });
        await aborted.promise;
        expect(stopped).toBe(false);
        expect(() => context.assertCurrent()).toThrow();
      } finally {
        finish.resolve();
        await (stopping ?? service.stop());
      }
      expect(stopped).toBe(true);
    });
  });

  it("binds device revocation to the persisted profile settings", async () => {
    const stateDir = tempDirs.make("openclaw-worker-startup-");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const startup = await loadGatewayWorkerEnvironmentStartupState();
        startup.store.createIntent({
          environmentId: "device-environment",
          providerId: DEVICE_WORKER_PROVIDER_ID,
          profileId: `device:${DEVICE_ID}`,
          profileSnapshot: { install: "bundle", settings: { device: DEVICE_ID } },
          provisionOperationId: "provision:device-environment",
        });
        startup.store.transition({
          environmentId: "device-environment",
          from: "requested",
          to: "provisioning",
        });
        startup.store.transition({
          environmentId: "device-environment",
          from: "provisioning",
          to: "ready",
          patch: {
            leaseId: "device-lease",
            nodeDeviceId: DEVICE_ID,
            sshEndpoint: null,
            sharedHost: true,
            bootstrapReceipt: {
              bundleHash: "a".repeat(64),
              openclawVersion: "2026.8.14",
              protocolFeatures: ["worker-heartbeat-v1"],
              installKind: "bundle",
            },
            credential: {
              credentialHash: hashWorkerCredential("device-credential"),
              sessionId: null,
              rpcSetVersion: 1,
              expiresAtMs: Date.now() + 60_000,
            },
          },
        });

        const registry = createEmptyPluginRegistry();
        const runtime = await createGatewayWorkerEnvironmentRuntime({
          getPluginRegistry: () => registry,
          getPortalRuntime: () => undefined,
          resolveGatewayContext: () => undefined,
          desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
          startup,
          log: { child: () => ({ warn: () => {} }) },
        });
        const service = runtime.workerEnvironmentService;
        if (!service) {
          throw new Error("worker environment service was not created");
        }
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
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("composes node desktop control into the worker environment runtime", async () => {
    const stateDir = tempDirs.make("openclaw-worker-node-desktop-startup-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      setRuntimeConfigSnapshot({ cloudWorkers: { desktop: true } });
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const intent = startup.store.createIntent({
        environmentId: "node-desktop-environment",
        providerId: "fake-provider",
        profileId: "desktop-profile",
        profileSnapshot: { settings: { desktop: true } },
        provisionOperationId: "provision:node-desktop-environment",
      });
      const provisioning = startup.store.transition({
        environmentId: intent.environmentId,
        from: intent.state,
        to: "provisioning",
      });
      const nodeId = "node-desktop-device";
      const app = { id: "terminal" as const, executablePath: "/usr/bin/true" };
      const record = startup.store.transition({
        environmentId: provisioning.environmentId,
        from: provisioning.state,
        to: "ready",
        patch: {
          leaseId: "node-desktop-lease",
          nodeDeviceId: nodeId,
          sshEndpoint: null,
          sharedHost: true,
          desktop: { protocol: "rfb", port: 5900, apps: [app] },
          bootstrapReceipt: {
            bundleHash: "a".repeat(64),
            openclawVersion: "2026.8.14",
            protocolFeatures: ["worker-heartbeat-v1"],
            installKind: "bundle",
          },
          credential: {
            credentialHash: hashWorkerCredential("node-desktop-credential"),
            sessionId: null,
            rpcSetVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        },
      });
      const proof: NodeWorkerSupervisorNodeProof = {
        nodeId,
        connId: "node-desktop-conn",
        pairingIdentity: "node-desktop-pairing",
        pairingGeneration: "node-desktop-generation",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: "node",
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
        commands: [],
      };
      const transport: NodeWorkerSupervisorTransport = {
        listCurrentNodes: async () => [proof],
        hasCurrentRunner: (candidateNodeId) => candidateNodeId === proof.nodeId,
        isCurrent: () => true,
        invoke: async (request) => {
          expect(request.isDispatchAuthorized()).toBe(true);
          return { ok: true, payloadJSON: '{"status":"ready"}' };
        },
      };
      const registry = createEmptyPluginRegistry();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => registry,
        getPortalRuntime: () => undefined,
        resolveGatewayContext: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        nodeDesktopStreamBroker: createNodeDesktopStreamBroker(),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service || !runtime.bindWorkerNodeDesktopControl) {
        throw new Error("worker node desktop runtime was not composed");
      }
      runtime.bindWorkerNodeDesktopControl(transport);
      try {
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(false);
        runtime.bindDeviceNodeControl?.(transport);
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(false);
        proof.workerHost.portalStream = NODE_WORKER_PORTAL_STREAM_VERSION;
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(true);
        delete proof.workerHost.portalStream;
        await expect(
          service.supportsNodePortal(record.environmentId, record.ownerEpoch),
        ).resolves.toBe(false);
        await expect(
          service.launchDesktopApp({ environmentId: record.environmentId, app: "terminal" }),
        ).resolves.toEqual({ app: "terminal", status: "ready" });
      } finally {
        await service.stop();
      }
    });
  });
});

describe("prepared node workspace ownership over the Gateway transport", () => {
  it.each([false, true])(
    "verifies the actual checkout before adopting it (source changed: %s)",
    async (changed) => {
      const root = await fs.realpath(tempDirs.make("openclaw-prepared-ack-"));
      await withPreparedNodeAcknowledgement(root, async (f) => {
        if (changed) {
          await fs.writeFile(path.join(f.prepared.workspaceDir, "source.txt"), "changed source\n");
          await expect(f.register()).rejects.toThrow("source does not match its manifest");
          expect(f.preparedStore.find(f.record.environmentId)).toBeUndefined();
          return;
        }
        await f.register();
        f.attach();
        await f.bind();
        expect(f.received.map((response) => response.ok)).toEqual([true, true]);
        const acquired = f.workspace.acquireManagedWorkspace({
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
    const root = await fs.realpath(tempDirs.make("openclaw-prepared-owner-"));
    await withPreparedNodeAcknowledgement(root, async (f) => {
      if (action === "bind") {
        await f.register();
        f.attach();
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
            f.startup.store.requestDestroy({
              environmentId: f.record.environmentId,
              state: "provisioning",
            });
          } else {
            f.startup.store.revokeEnvironmentCredential(f.record.environmentId);
          }
        } else if (loss === "placement") {
          const placement = f.startup.placementStore.get(f.binding.sessionId)!;
          f.startup.placementStore.transition({
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
        const registration = f.preparedStore.find(f.record.environmentId);
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
    const root = await fs.realpath(tempDirs.make("openclaw-prepared-abort-"));
    await withPreparedNodeAcknowledgement(root, async (f) => {
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
        expect(f.preparedStore.find(f.record.environmentId)).toBeUndefined();
      } finally {
        caller.abort();
        release.resolve();
        await registering;
        await f.settleInvokes();
      }
    });
  });
});
