import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { WorkerProvider } from "../../plugins/types.js";
import * as runtimeVersion from "../../version.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  waitForNodeWorkerSupervisor,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { createWorkerSupervisorNodeClient } from "../server-methods/nodes.runner-inventory.test-support.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { testState } from "./service.test-support.js";

describe("same enrolled node admission recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function setup(
    options: { connected?: boolean; capable?: boolean; prepared?: boolean } = {},
  ) {
    const environmentId = "resume-worker";
    await testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      provisionOperationId: "resume-operation",
      profileSnapshot: {
        settings: { region: "test" },
        ...(options.prepared === false
          ? {}
          : {
              runtimePreparation: {
                source: "empty",
                key: "c".repeat(64),
                cacheKey: "d".repeat(64),
                contractVersion: 2,
                target: { machineClass: "test", platform: "linux" },
                artifacts: {
                  nodeBootstrapSha256: "b".repeat(64),
                  enabledPluginIds: [],
                  workerBundleHash: support.BUNDLE_HASH,
                  workerArchiveSha256: "e".repeat(64),
                  openclawVersion: "2026.7.2",
                  protocolFeatures: [],
                },
              },
            }),
      },
    });
    await testState.store.transition({ environmentId, from: "requested", to: "provisioning" });
    await testState.store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId),
        leaseId: "lease-1",
        nodeDeviceId: "device-1",
        sharedHost: false,
      },
    });
    const environment = await testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const placements = createWorkerSessionPlacementStore({ database: testState.stateDb });
    const placement = await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: environment.ownerEpoch,
    });
    if (placement.state !== "active") {
      throw new Error("Expected an active fixture placement");
    }
    const admittedEnvironment = testState.store.get(environmentId);
    if (!admittedEnvironment) {
      throw new Error("Expected the fixture environment");
    }
    let running = options.connected === true;
    const resumeNode = vi.fn<NonNullable<WorkerProvider["resumeNode"]>>(async (request) => {
      request.assertCurrent();
      running = true;
    });
    const provision = vi.fn(support.createProvider().provision);
    const inspect = vi.fn<WorkerProvider["inspect"]>(async () => ({
      status: "active",
      sharedHost: false,
    }));
    const service = support.createService(
      support.createProvider({
        ...(options.capable === false ? {} : { resumeNode }),
        inspect,
        provision,
      }),
      {
        placementStore: createWorkerSessionPlacementGate(placements),
        prepareNodeRuntime: async (_record, _artifact, _signal, assertCurrent) => {
          assertCurrent?.();
          return {
            nodeBootstrap: {
              ...support.NODE_BOOTSTRAP,
              sha256: "b".repeat(64),
              openclawVersion: "2026.7.2",
            },
            workerBundle: {
              url: "https://gateway.example.test/worker",
              token: "synthetic-worker-token",
              sha256: "e".repeat(64),
              bytes: 1,
              packageRelativePath: `worker-artifacts/${"e".repeat(64)}.tar.gz`,
            },
          };
        },
        closeNodeRuntime() {},
      },
    );
    const waiter = createWorkerRuntimeRefreshWaiter({
      environments: service,
      isStopping: () => false,
      hasCurrentRunner: () => running,
    });
    waiter.bind(async () => {
      expect(running, "reconnect wait must have a node process to reconnect").toBe(true);
    });
    return {
      environment: admittedEnvironment,
      placement,
      service,
      waiter,
      resumeNode,
      inspect,
      provision,
    };
  }

  it.each(["older version", "same version, stale build"] as const)(
    "waits for the upgraded connected node before admission: %s",
    async (mode) => {
      const h = await setup({ connected: true });
      const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
        () => new NodeRegistry(),
      );
      const connect = (connectionId: string, version: string, buildId: string) => {
        const client = createWorkerSupervisorNodeClient(connectionId);
        if (!client.connect.device) {
          throw new Error("Node fixture requires device identity");
        }
        client.connect.device.id = "device-1";
        client.connect.client.version = version;
        client.connect.client.buildId = buildId;
        nodeRegistry.register(client, {
          pairingIdentity: "identity-a",
          pairingGeneration: "generation-a",
        });
        updateNodeRunnerInventory({
          registry: nodeRegistry,
          nodeId: "device-1",
          connId: connectionId,
          declaration: {
            protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
            workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
          },
        });
      };
      connect(
        "old-runtime",
        mode === "older version" ? "2026.1.1" : runtimeVersion.VERSION,
        "old-build",
      );
      vi.spyOn(runtimeVersion, "resolveRuntimeServiceBuildId").mockReturnValue("current-build");
      const resumeGate = createDeferred();
      const resuming = createDeferred();
      const oldProof = createDeferred();
      const checkedVersion = createDeferred();
      const originalRead = nodeWorkerSupervisorTransport.getCurrentNode.bind(
        nodeWorkerSupervisorTransport,
      );
      vi.spyOn(nodeWorkerSupervisorTransport, "getCurrentNode").mockImplementation(
        async (nodeId) => {
          const proof = await originalRead(nodeId);
          oldProof.resolve();
          return proof;
        },
      );
      const resume = vi.spyOn(h.service, "resumeNode").mockImplementation(async (_id, request) => {
        request.assertCurrent();
        resuming.resolve();
        await resumeGate.promise;
        request.assertCurrent();
      });
      const waiter = createWorkerRuntimeRefreshWaiter({
        environments: h.service,
        isStopping: () => false,
        hasCurrentRunner: (id) => nodeWorkerSupervisorTransport.hasCurrentRunner(id),
      });
      let versionReads = 0;
      waiter.bind(
        (id, options) => waitForNodeWorkerSupervisor(nodeRegistry, id, options),
        (id) => {
          if (++versionReads > 1) {
            checkedVersion.resolve();
          }
          return nodeRegistry.get(id)?.version;
        },
        (id) => nodeRegistry.get(id)?.client.connect.client.buildId,
      );
      const controller = new AbortController();
      let finished = false;
      const waiting = waiter
        .wait({ placement: h.placement, signal: controller.signal, assertCurrent() {} })
        .then(() => {
          finished = true;
        });
      try {
        expect(
          await Promise.race([
            resuming.promise.then(() => "upgrade"),
            oldProof.promise.then(() => "old runner"),
          ]),
        ).toBe("upgrade");
        resumeGate.resolve();
        await checkedVersion.promise;
        expect(finished).toBe(false);
        connect("upgraded-runtime", runtimeVersion.VERSION, "current-build");
        await waiting;
        expect(finished).toBe(true);
        expect(resume).toHaveBeenCalledOnce();
        expect(resume.mock.calls[0]?.[1]).toMatchObject({ upgradeRuntime: true });
        expect(h.provision).not.toHaveBeenCalled();
        expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
      } finally {
        resumeGate.resolve();
        controller.abort();
        await waiting.catch(() => {});
        nodeRegistry.unregister("old-runtime");
        nodeRegistry.unregister("upgraded-runtime");
      }
    },
  );

  it("restarts the exact enrolled lease before reconnect without provisioning or changing custody", async () => {
    const h = await setup();
    await h.waiter.wait({
      placement: h.placement,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    expect(h.resumeNode).toHaveBeenCalledOnce();
    expect(h.resumeNode.mock.calls[0]![0]).toMatchObject({
      leaseId: "lease-1",
      deviceId: "device-1",
      nodeBootstrapSha256: "b".repeat(64),
      openclawVersion: "2026.7.2",
      platform: "linux",
    });
    expect(() => h.resumeNode.mock.calls[0]![0].assertCurrent()).toThrow(
      "placement authority changed",
    );
    expect(h.provision).not.toHaveBeenCalled();
    expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
  });

  it.each([{ connected: true }, { capable: false }, { prepared: false }])(
    "retains reconnect without provider work for %j",
    async (options) => {
      const h = await setup(options);
      const reconnected = vi.fn(async () => {});
      h.waiter.bind(reconnected);
      await h.waiter.wait({
        placement: h.placement,
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(h.inspect).not.toHaveBeenCalled();
      expect(h.resumeNode).not.toHaveBeenCalled();
    },
  );

  it.each<Awaited<ReturnType<WorkerProvider["inspect"]>>>([
    { status: "active" },
    { status: "active", sharedHost: true },
    { status: "dormant" },
    { status: "unknown" },
    { status: "destroyed" },
  ])("refuses restart without explicit dedicated active observation: %j", async (inspection) => {
    const h = await setup();
    h.inspect.mockResolvedValue(inspection);
    await expect(
      h.waiter.wait({
        placement: h.placement,
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow("active dedicated lease");
    expect(h.resumeNode).not.toHaveBeenCalled();
    expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
  });

  it.each(["cancel", "authority", "unavailable"])(
    "holds recovery when %s interrupts inspection",
    async (reason) => {
      const h = await setup();
      const controller = new AbortController();
      let current = true;
      h.inspect.mockImplementation(async () => {
        if (reason === "cancel") {
          controller.abort(new Error("cancelled"));
        }
        if (reason === "authority") {
          current = false;
        }
        if (reason === "unavailable") {
          throw new Error("provider unavailable");
        }
        return { status: "active", sharedHost: false };
      });
      await expect(
        h.waiter.wait({
          placement: h.placement,
          signal: controller.signal,
          assertCurrent() {
            if (!current) {
              throw new Error("authority changed");
            }
          },
        }),
      ).rejects.toThrow();
      expect(h.resumeNode).not.toHaveBeenCalled();
      expect(h.provision).not.toHaveBeenCalled();
      expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
    },
  );
});
