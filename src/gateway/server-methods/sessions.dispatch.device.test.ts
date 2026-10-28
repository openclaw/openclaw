import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type EnvironmentSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
} from "../worker-environments/device-provider.js";
import { createNodeWorkerBundleTestNode } from "../worker-environments/node-worker-bundle.test-support.js";
import { coordinateWorkerPlacementDispatch } from "../worker-environments/placement-dispatch-coordinator.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import type { WorkerPlacementDispatchService } from "../worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { activePlacement } from "../worker-environments/placement-suite.test-support.js";
import { deriveEnvironmentIntent } from "../worker-environments/service-contract.js";
import {
  dispatchTestSessionId,
  dispatchTestSessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  invokeSessionDispatch,
  makeDispatchTestContext,
  makeSessionTarget,
  createCodexDeviceHarness,
} from "./sessions-dispatch.test-support.js";
import { registerNativeDeviceDispatchTests } from "./sessions.dispatch.native-device.suite.js";

// Install session-store fixtures before environment handlers load their session accessors.
const environmentMethods = await import("./environments.js");
const dispatchTestMocks = getDispatchTestMocks();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    // Automatic session maintenance can retain shared-state readers after dispatch returns.
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    cleanup();
  });
});

function useDeviceSession(agentRuntimeOverride?: string, sessionId = dispatchTestSessionId): void {
  dispatchTestMocks.resolveTarget.mockReturnValue(
    makeSessionTarget({
      sessionId,
      ...(agentRuntimeOverride
        ? {
            agentHarnessId: agentRuntimeOverride,
            agentRuntimeOverride,
            modelSelectionLocked: true,
            modelOverride: "gpt-test",
            providerOverride: "openai",
          }
        : {}),
      worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
    }),
  );
  dispatchTestMocks.findLiveByOwner.mockReturnValue({
    id: "worktree-1",
    ownerKind: "session",
    ownerId: dispatchTestSessionKey,
  });
}

function pairedNode(deviceId: string): PairedDevice {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    role: "node",
    roles: ["node"],
    tokens: {
      node: {
        token: "fixture-token",
        role: "node",
        scopes: [],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function connectedNode(deviceId: string, available: number): NodeWorkerSupervisorNodeProof {
  return createNodeWorkerBundleTestNode({
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    workerHost: {
      capacity: { total: Math.max(2, available), available },
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["system.run"],
  });
}

function activeDevicePlacement(
  deviceId: string,
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return activePlacement(dispatchTestSessionId, {
    sessionKey: dispatchTestSessionKey,
    environmentId: `device-environment-${deviceId}`,
    generation: 1,
    activeOwnerEpoch: 2,
    workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
    remoteWorkspaceDir: "/node/workspace",
    workerBundleHash: "b".repeat(64),
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  });
}

function deviceEnvironments(
  nodes: readonly ReturnType<typeof connectedNode>[],
): EnvironmentSummary[] {
  return nodes.map((node) => ({
    id: `node:${node.nodeId}`,
    type: "node" as const,
    status: "available" as const,
    sessionHost: true,
    workerSlots: { ...node.workerHost.capacity },
  }));
}

describe("sessions.dispatch device targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchTestMocks.resolveTarget.mockReturnValue(makeSessionTarget());
  });

  registerNativeDeviceDispatchTests({
    connectedNode,
    pairedNode,
    useDeviceSession,
    activeDevicePlacement,
  });

  describe("automatic paired-device selection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(["unpaired", "reconnected"] as const)(
      "reports live %s refusal instead of stale full capacity",
      async (reason) => {
        useDeviceSession();
        const node = connectedNode("unavailable", 0);
        vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
          deviceEnvironments([node]),
        );
        const dispatch = vi.fn();
        const context = makeDispatchTestContext({
          nodeRegistry: { get: () => node } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        });
        bindDeviceWorkerAvailability(context.workerEnvironmentService!, async () =>
          reason === "unpaired"
            ? { available: false, unavailableReason: "unpaired" }
            : { available: true, node: { ...node, connId: "replacement-connection" } },
        );

        const respond = await invokeSessionDispatch(context, { autoDevice: true });

        expect(dispatch).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.INVALID_REQUEST,
            message: expect.stringContaining(
              reason === "unpaired" ? "not a paired" : "not connected",
            ),
          }),
        );
      },
    );

    it.each([{ autoDevice: true as const, deviceId: "device-1" }])(
      "rejects automatic selection combined with an explicit target: %j",
      async (target) => {
        const dispatch = vi.fn();
        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            workerPlacementDispatchService: { dispatch },
            workerSessionPlacementService: { getMany: () => new Map() },
          }),
          target,
        );

        expect(dispatch).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.INVALID_REQUEST,
            message: expect.stringMatching(/choose exactly one.*autoDevice.*deviceId.*profileId/i),
          }),
        );
      },
    );

    it("spreads six concurrent Auto dispatches across three two-slot nodes", async () => {
      const nodes = ["first", "second", "third"].map((id) => connectedNode(id, 2));
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      dispatchTestMocks.resolveTarget.mockImplementation(({ key }: { key: string }) => {
        const target = makeSessionTarget({
          sessionId: key,
          worktree: { id: key, branch: "test", repoRoot: "/repo" },
        });
        return {
          ...target,
          canonicalKey: key,
          storeKeys: [key],
          store: { [key]: target.store[dispatchTestSessionKey] },
        };
      });
      dispatchTestMocks.findLiveByOwner.mockImplementation((_kind: string, key: string) => ({
        id: key,
        ownerId: key,
        ownerKind: "session",
      }));
      const release = createDeferredCore();
      const entered = createDeferredCore();
      const assigned: string[] = [];
      const service = coordinateWorkerPlacementDispatch(
        {
          dispatch: async (request) => {
            assigned.push(request.deviceId!);
            if (assigned.length === 6) {
              entered.resolve();
            }
            await release.promise;
            return {
              ...activeDevicePlacement(request.deviceId!),
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
            };
          },
        } as WorkerPlacementDispatchService,
        async (_request, run) => await run(),
      );
      const context = makeDispatchTestContext({
        nodeRegistry: { get: (id: string) => nodes.find((node) => node.nodeId === id) } as never,
        workerPlacementDispatchService: service,
        workerSessionPlacementService: { getMany: () => new Map() },
      });
      const responses = Array.from({ length: 6 }, () => vi.fn());
      const requests = responses.map(
        async (respond, index) =>
          await getSessionDispatchHandler()({
            req: { id: `request-${index}` } as never,
            params: { key: `agent:main:burst-${index}`, autoDevice: true },
            respond,
            context,
            client: null,
            isWebchatConnect: () => false,
          }),
      );
      try {
        await entered.promise;
        expect(assigned.toSorted()).toEqual([
          "first",
          "first",
          "second",
          "second",
          "third",
          "third",
        ]);
      } finally {
        release.resolve();
        await Promise.all(requests);
      }
      for (const respond of responses) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
    });

    it("explains how to recover when no paired node can host sessions", async () => {
      useDeviceSession();
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue([]);
      const dispatch = vi.fn();
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: { get: () => undefined } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("pair a node, enable session hosting"),
        }),
      );
    });

    it.each([
      { name: "disconnects", unavailableReason: "disconnected" as const },
      { name: "fills its worker slots", unavailableReason: "at-capacity" as const },
    ])(
      "tries the next host when the first $name before dispatch",
      async ({ unavailableReason }) => {
        useDeviceSession();
        const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
        vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
          deviceEnvironments(nodes),
        );
        let firstChecks = 0;
        const workerEnvironmentService = { get: () => undefined };
        bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) => {
          if (deviceId === "first" && ++firstChecks >= 2) {
            return unavailableReason === "disconnected"
              ? { available: false, unavailableReason }
              : { available: true, node: connectedNode(deviceId, 0) };
          }
          return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
        });
        const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("second"));

        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            nodeRegistry: {
              get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
            } as never,
            workerEnvironmentService: workerEnvironmentService as never,
            workerPlacementDispatchService: { dispatch },
            workerSessionPlacementService: { getMany: () => new Map() },
          }),
          { autoDevice: true },
        );

        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ profileId: "device:second", deviceId: "second" }),
          expect.any(Function),
          expect.any(Function),
          undefined,
        );
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            placement: expect.objectContaining({
              runner: { kind: "device", status: "available", deviceId: "second" },
            }),
          }),
          undefined,
        );
      },
    );

    it.each([
      {
        name: "disconnects after dispatch starts",
        afterAllocation: false,
        destroyFails: false,
        generation: 3,
      },
      {
        name: "loses capacity and cleanup succeeds",
        afterAllocation: true,
        destroyFails: false,
        generation: 4,
      },
      {
        name: "loses capacity and cleanup fails",
        afterAllocation: true,
        destroyFails: true,
        generation: 4,
      },
    ])(
      "rotates the first host only after cleanup when it $name",
      async ({ afterAllocation, destroyFails, generation }) => {
        const root = tempDirs.make("openclaw-auto-device-retry-");
        if (afterAllocation) {
          // Exercise maintenance against warm shared preferences, as in a running Gateway.
          openOpenClawStateDatabase();
        }
        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        const first = await createHarness(database, placements, { destroyFails });
        // Pre-allocation failure advances twice; allocated teardown adds another generation.
        const second = await createHarness(database, placements, {
          environmentGeneration: generation,
        });
        const nodes = [
          connectedNode("first", afterAllocation ? 2 : 3),
          connectedNode("second", afterAllocation ? 1 : 2),
        ];
        vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
          deviceEnvironments(nodes),
        );
        let dispatchStarted = false;
        let firstAllocated = false;
        const startDispatch = placements.startDispatch.bind(placements);
        vi.spyOn(placements, "startDispatch").mockImplementation(async (...args) => {
          const placement = await startDispatch(...args);
          dispatchStarted = true;
          return placement;
        });
        const availability = async (deviceId: string) => {
          if (deviceId === "first") {
            if (!afterAllocation && dispatchStarted) {
              return { available: false, unavailableReason: "disconnected" as const };
            }
            if (afterAllocation && firstAllocated) {
              return { available: true, node: connectedNode("first", 0) };
            }
          }
          return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
        };
        for (const [harness, deviceId] of [
          [first, "first"],
          [second, "second"],
        ] as const) {
          bindDeviceWorkerAvailability(harness.environments, availability);
          vi.mocked(harness.environments.createWithRequest).mockImplementation(async () => {
            if (deviceId === "first") {
              firstAllocated = true;
            }
            return {
              ...harness.ready,
              providerId: "device",
              profileId: `device:${deviceId}`,
              profileSnapshot: { install: "bundle", settings: { device: deviceId } },
              nodeDeviceId: deviceId,
              sshEndpoint: null,
              sharedHost: true,
            };
          });
          // Attachment resets the synthetic environment; preserve its paired-device binding.
          const attach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
          vi.mocked(harness.environments.attachSession).mockImplementation(async (...args) => {
            const credential = await attach(...args);
            harness.markEnvironmentNodeDeviceId(deviceId);
            return credential;
          });
        }
        const environments = {
          ...first.environments,
          get: (id: string) =>
            id === first.ready.environmentId
              ? first.environments.get(id)
              : id === second.ready.environmentId
                ? second.environments.get(id)
                : undefined,
        };
        bindDeviceWorkerAvailability(environments, availability);
        useDeviceSession(undefined, "session-1");
        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            nodeRegistry: {
              get: (id: string) => nodes.find((node) => node.nodeId === id),
            } as never,
            workerPlacementDispatchService: {
              dispatch: (...args) =>
                (args[0].deviceId === "first" ? first : second).service.dispatch(...args),
            },
            workerSessionPlacementService: placements,
            workerEnvironmentService: environments as never,
          }),
          { autoDevice: true },
        );

        expect(first.environments.createWithRequest).toHaveBeenCalledTimes(afterAllocation ? 1 : 0);
        expect(first.environments.attachSession).not.toHaveBeenCalled();
        expect(first.environments.destroy).toHaveBeenCalledTimes(afterAllocation ? 1 : 0);
        expect(second.environments.createWithRequest).toHaveBeenCalledTimes(destroyFails ? 0 : 1);
        expect(respond).toHaveBeenCalledWith(
          !destroyFails,
          destroyFails
            ? undefined
            : expect.objectContaining({
                placement: expect.objectContaining({
                  runner: { kind: "device", status: "available", deviceId: "second" },
                }),
              }),
          destroyFails
            ? expect.objectContaining({ message: expect.stringContaining("at capacity") })
            : undefined,
        );
        expect(await placements.getAsync("session-1")).toMatchObject({
          state: destroyFails ? "failed" : "active",
        });
        if (!afterAllocation) {
          const provision = vi.mocked(second.environments.createWithRequest).mock.calls[0]?.[0];
          expect(provision?.idempotencyKey).toBe("session-dispatch:session-1:3");
          expect(second.ready.environmentId).toBe(
            deriveEnvironmentIntent(provision?.idempotencyKey ?? "missing").environmentId,
          );
          expect([...first.log, ...second.log]).toEqual(
            expect.arrayContaining(["placement:requested", "placement:failed", "placement:active"]),
          );
        }
      },
    );
  });

  describe("runtime-owned paired-node command authority", () => {
    let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

    beforeEach(() => {
      previousPluginRegistry = getActivePluginRegistry();
      setActivePluginRegistry(
        createEmptyPluginRegistry(),
        "sessions-dispatch-device-test",
        "default",
      );
      registerAgentHarness(createCodexDeviceHarness());
    });

    afterEach(() => {
      if (previousPluginRegistry) {
        setActivePluginRegistry(
          previousPluginRegistry,
          "sessions-dispatch-device-test-restore",
          "default",
        );
      } else {
        resetPluginRuntimeStateForTest();
      }
    });

    it.each([
      {
        name: "missing",
        declaredCommands: ["system.run"],
        commandPolicy: { allow: ["codex.exec-server.stdio.v1"] },
        expectedMessage:
          "paired-device command codex.exec-server.stdio.v1 is not advertised by node device-1; enable the plugin or node capability that provides this command on that node, then restart the node (openclaw node restart) and approve its updated command surface",
      },
      {
        name: "declared but denied",
        declaredCommands: ["system.run", "codex.exec-server.stdio.v1"],
        commandPolicy: { deny: ["codex.exec-server.stdio.v1"] },
        expectedMessage:
          "paired-device command codex.exec-server.stdio.v1 is blocked by Gateway policy for node device-1; allow it in gateway.nodes.commands.allow and remove any matching gateway.nodes.commands.deny entry",
      },
    ])("rejects a $name required paired-node command before dispatch", async (scenario) => {
      useDeviceSession("codex");
      const dispatch = vi.fn();
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          getRuntimeConfig: () => ({
            gateway: { nodes: { commands: scenario.commandPolicy } },
          }),
          nodeRegistry: {
            get: () => ({
              nodeId: "device-1",
              platform: "darwin",
              commands: scenario.declaredCommands,
              client: {},
            }),
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { deviceId: "device-1" },
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: scenario.expectedMessage,
        }),
      );
    });

    it.each([
      { name: "dispatches an opted-in runtime", runtimeId: "codex", supported: true },
      { name: "rejects a runtime without opt-in", runtimeId: "cloud-only", supported: false },
    ])("$name to a paired device", async ({ runtimeId, supported }) => {
      if (!supported) {
        registerAgentHarness({
          id: runtimeId,
          label: "Cloud only",
          cloudPlacement: { mode: "remote-exec" },
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("not used");
          },
        });
      }
      useDeviceSession(runtimeId);
      const dispatch = vi.fn().mockRejectedValue(new Error("paired-device dispatch reached"));
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          getRuntimeConfig: () => ({
            gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
          }),
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { deviceId: "device-1" },
      );

      if (supported) {
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            executionMode: "remote-exec",
            profileId: "device:device-1",
            deviceId: "device-1",
          }),
          expect.any(Function),
          expect.any(Function),
          undefined,
        );
      } else {
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: supported ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          message: supported
            ? "paired-device dispatch reached"
            : "runtime cloud-only does not support paired-device placement; select a compatible runtime or cloud worker provider",
        }),
      );
    });
  });

  it.each([
    {
      name: "full",
      nodes: [connectedNode("device-1", 0)],
      expectedMessage: "at capacity (all worker slots in use)",
      rejectedMessage: "reconnect",
    },
    {
      name: "disconnected",
      nodes: [],
      expectedMessage: "reconnect",
      rejectedMessage: "at capacity",
    },
  ])(
    "rejects a $name node before mutating placement or provisioning",
    async ({ nodes, expectedMessage, rejectedMessage }) => {
      const root = tempDirs.make("openclaw-session-dispatch-device-");
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
      const harness = await createHarness(database, placements);
      const runtime = createDeviceWorkerRuntime({
        getPairedDevice: async (deviceId) => pairedNode(deviceId),
      });
      runtime.bindNodeTransport({
        getCurrentNode: async (nodeId) => nodes.find((node) => node.nodeId === nodeId),
        listCurrentNodes: async () => nodes,
        hasCurrentRunner: () => nodes.length > 0,
        isCurrent: () => true,
        invoke: async () => ({ ok: false }),
      });
      bindDeviceWorkerAvailability(harness.environments, runtime.resolveAvailability);

      useDeviceSession();
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          workerPlacementDispatchService: harness.service,
          workerSessionPlacementService: placements,
          workerEnvironmentService: harness.environments as never,
        }),
        { deviceId: "device-1" },
      );

      const placement = await placements.getAsync(dispatchTestSessionId);
      expect(placement).toBeUndefined();
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(harness.environments.startTunnel).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining(expectedMessage),
        }),
      );
      expect(respond).not.toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining(rejectedMessage) }),
      );
    },
  );
});
