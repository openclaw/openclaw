import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  type EnvironmentSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { handleGatewayRequest } from "../server-methods.js";
import { DevicePlacementUnavailableError } from "../worker-environments/device-placement-eligibility.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
} from "../worker-environments/device-provider.js";
import { coordinateWorkerPlacementDispatch } from "../worker-environments/placement-dispatch-coordinator.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import type { WorkerPlacementDispatchService } from "../worker-environments/placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { deriveEnvironmentIntent } from "../worker-environments/service-contract.js";
import { createWorkerEnvironmentService } from "../worker-environments/service.js";
import { BUNDLE_ARTIFACT, BOOTSTRAP_RECEIPT } from "../worker-environments/service.test-support.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import {
  dispatchTestSessionId,
  dispatchTestSessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  invokeSessionDispatch,
  makeDispatchTestContext,
  makeFailedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";
import type { GatewayClient } from "./types.js";

// Install session-store fixtures before environment handlers load their session accessors.
const environmentMethods = await import("./environments.js");
const dispatchTestMocks = getDispatchTestMocks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function useDeviceSession(agentRuntimeOverride?: string): void {
  dispatchTestMocks.resolveTarget.mockReturnValue(
    makeSessionTarget({
      sessionId: dispatchTestSessionId,
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

function connectedNode(deviceId: string, available: number) {
  return {
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: Math.max(2, available), available },
      capturedExecPolicy: true,
    },
    commands: ["system.run"],
  } satisfies NodeWorkerSupervisorNodeProof;
}

function activeDevicePlacement(
  deviceId: string,
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    sessionId: dispatchTestSessionId,
    agentId: "main",
    sessionKey: dispatchTestSessionKey,
    executionMode: "worker-turn",
    state: "active",
    environmentId: `device-environment-${deviceId}`,
    generation: 1,
    activeOwnerEpoch: 2,
    workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
    remoteWorkspaceDir: "/node/workspace",
    workerBundleHash: "b".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  };
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

  it("admits a named native device profile with admin authority and preserves its provider snapshot", async () => {
    const root = tempDirs.make("openclaw-dispatch-named-native-device-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const store = await createWorkerEnvironmentStore({ database });
    const config = {
      cloudWorkers: {
        profiles: {
          "dedicated-native": {
            provider: "device",
            settings: { device: "scenario2-paired-node", inference: "runtime-local" },
          },
        },
      },
    };
    const node = connectedNode("scenario2-paired-node", 2);
    const runtime = createDeviceWorkerRuntime({
      getPairedDevice: async (id) => (id === node.nodeId ? pairedNode(id) : null),
    });
    runtime.bindNodeTransport({
      getCurrentNode: async (id) => (id === node.nodeId ? node : undefined),
      listCurrentNodes: async () => [node],
      hasCurrentRunner: () => true,
      isCurrent: (candidate) => candidate === node,
      invoke: async () => ({ ok: false }),
    });
    const provision = vi.spyOn(runtime.provider, "provision");
    const bootstrapWorker = vi.fn();
    const ensureNodeWorkerBundle = vi.fn(async () => BOOTSTRAP_RECEIPT);
    const service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: (id) => (id === "device" ? runtime.provider : undefined),
      prepareInstallation: async () => BUNDLE_ARTIFACT,
      bootstrapWorker,
      ensureNodeWorkerBundle,
      executeInference: vi.fn(),
    });
    const previousRegistry = getActivePluginRegistry();
    // Core device placement must not require a fabricated plugin owner/manifest.
    setActivePluginRegistry(createEmptyPluginRegistry(), "named-native-device", "default");
    try {
      useDeviceSession();
      // Exercise RPC admission and the real profile/provider lifecycle; workspace sync
      // and placement activation remain the existing dispatch fixture boundary.
      const dispatch = vi.fn<WorkerPlacementDispatchService["dispatch"]>(
        async (request, _onTransition, authorize) => {
          authorize?.();
          const intent = await service.prepareProjectIntent(request.profileId, {
            executionMode: request.executionMode,
            runSetupScript: request.runSetupScript,
          });
          expect(intent).toMatchObject({
            providerId: "device",
            profileSnapshot: {
              executionMode: "worker-turn",
              settings: { device: node.nodeId, inference: "runtime-local" },
            },
          });
          expect(intent.profileSnapshot.settings).not.toBe(
            config.cloudWorkers.profiles["dedicated-native"].settings,
          );
          authorize?.();
          const environment = await service.createWithRequest({
            profileId: request.profileId,
            idempotencyKey: "scenario2-named-device",
            executionMode: request.executionMode,
            runSetupScript: request.runSetupScript,
            admittedIntent: intent,
          });
          expect(environment).toMatchObject({
            providerId: "device",
            profileId: "dedicated-native",
            nodeDeviceId: node.nodeId,
            sharedHost: true,
            sshEndpoint: null,
            profileSnapshot: { settings: { device: node.nodeId, inference: "runtime-local" } },
          });
          return {
            ...activeDevicePlacement(node.nodeId),
            environmentId: environment.environmentId,
          };
        },
      );
      const context = makeDispatchTestContext({
        getRuntimeConfig: () => config,
        logGateway: { warn: vi.fn() } as never,
        workerEnvironmentService: service,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      });
      const request = async (scope: "operator.write" | "operator.admin") => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: `scenario2-${scope}`,
            method: "sessions.dispatch",
            params: { key: dispatchTestSessionKey, profileId: "dedicated-native" },
          },
          respond,
          context,
          isWebchatConnect: () => false,
          client: {
            connId: `scenario2-${scope}`,
            connect: {
              role: "operator",
              scopes: [scope],
              client: { id: "test", version: "1", platform: "test", mode: "test" },
              minProtocol: 1,
              maxProtocol: 1,
            },
          } as GatewayClient,
          extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
        });
        return respond;
      };
      const denied = await request("operator.write");
      expect(denied).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          details: expect.objectContaining({ missingScope: "operator.admin" }),
        }),
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(store.list()).toEqual([]);

      const accepted = await request("operator.admin");
      expect(accepted).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        profileId: "dedicated-native",
        executionMode: "worker-turn",
        runSetupScript: true,
      });
      expect(provision).toHaveBeenCalledExactlyOnceWith(
        { device: node.nodeId, inference: "runtime-local" },
        expect.any(String),
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(ensureNodeWorkerBundle).toHaveBeenCalledOnce();
      expect(bootstrapWorker).not.toHaveBeenCalled();
      config.cloudWorkers.profiles["dedicated-native"].settings.inference = "gateway";
      expect(store.list()[0]?.profileSnapshot.settings).toEqual({
        device: node.nodeId,
        inference: "runtime-local",
      });
    } finally {
      await service.stop();
      closeOpenClawStateDatabaseForTest();
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry, "named-native-device-restore", "default");
      } else {
        resetPluginRuntimeStateForTest();
      }
      vi.restoreAllMocks();
    }
  });

  it("synthesizes the core device-provider target for a connected session-capable node", async () => {
    useDeviceSession();
    const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("device-1"));
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "device:device-1",
        deviceId: "device-1",
        inheritedProfile: {
          providerId: "device",
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });

  it("returns a device dispatch failure to the operator", async () => {
    useDeviceSession();
    const dispatch = vi
      .fn()
      .mockRejectedValue(
        new Error("device worker node is not connected: device-1; reconnect it before retrying"),
      );
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("reconnect"),
      }),
    );
  });

  describe("automatic paired-device selection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("dispatches to the highest-capacity eligible host and identifies it in the response", async () => {
      useDeviceSession();
      const nodes = [connectedNode("smaller", 1), connectedNode("largest", 4)];
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      const dispatch = vi.fn().mockResolvedValue(activeDevicePlacement("largest"));
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "device:largest", deviceId: "largest" }),
        expect.any(Function),
        undefined,
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          placement: expect.objectContaining({
            runner: { kind: "device", status: "available", deviceId: "largest" },
          }),
        }),
        undefined,
      );
    });

    it.each([
      { autoDevice: true as const, profileId: "test" },
      { autoDevice: true as const, deviceId: "device-1" },
    ])("rejects automatic selection combined with an explicit target: %j", async (target) => {
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
    });

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
          undefined,
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

    it("redispatches to the next host when the first disappears at the inner eligibility fence", async () => {
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-session-auto-device-"),
      );
      try {
        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        // A local row starts at generation one; failed and retried dispatches advance it twice.
        const harness = createHarness(database, placements, { environmentGeneration: 3 });
        const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
        vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
          deviceEnvironments(nodes),
        );
        const firstChecks = { count: 0 };
        bindDeviceWorkerAvailability(harness.environments, async (deviceId) => {
          if (deviceId === "first" && ++firstChecks.count >= 4) {
            return { available: false, unavailableReason: "disconnected" };
          }
          return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
        });
        vi.mocked(harness.environments.createWithRequest).mockResolvedValue({
          ...harness.ready,
          providerId: "device",
          profileId: "device:second",
          profileSnapshot: { install: "bundle", settings: { device: "second" } },
          nodeDeviceId: "second",
          sshEndpoint: null,
          sharedHost: true,
        });
        // attachSession resets the fixture environment; restamp the paired
        // device binding so the canonical runner reader can name the host.
        const attachSessionActual = vi
          .mocked(harness.environments.attachSession)
          .getMockImplementation();
        vi.mocked(harness.environments.attachSession).mockImplementation(async (...args) => {
          const minted = await attachSessionActual?.(...args);
          harness.markEnvironmentNodeDeviceId("second");
          return minted as Awaited<ReturnType<typeof harness.environments.attachSession>>;
        });
        dispatchTestMocks.resolveTarget.mockReturnValue(
          makeSessionTarget({
            sessionId: "session-1",
            worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
          }),
        );
        dispatchTestMocks.findLiveByOwner.mockReturnValue({
          id: "worktree-1",
          ownerKind: "session",
          ownerId: dispatchTestSessionKey,
        });

        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            nodeRegistry: {
              get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
            } as never,
            workerPlacementDispatchService: harness.service,
            workerSessionPlacementService: placements,
            workerEnvironmentService: harness.environments as never,
          }),
          { autoDevice: true },
        );

        const provisionCall = vi.mocked(harness.environments.createWithRequest).mock.calls[0]?.[0];
        expect(provisionCall?.idempotencyKey).toBe("session-dispatch:session-1:3");
        expect(harness.ready.environmentId).toBe(
          deriveEnvironmentIntent(provisionCall?.idempotencyKey ?? "missing").environmentId,
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
        expect(harness.log).toEqual(
          expect.arrayContaining(["placement:requested", "placement:failed", "placement:active"]),
        );
        expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
        expect(placements.get("session-1")).toMatchObject({ state: "active" });
      } finally {
        closeOpenClawStateDatabaseForTest();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it.each([false, true])(
      "rotates a capacity loss before workspace preparation only after cleanup settles (cleanup failure: %s)",
      async (destroyFails) => {
        const root = tempDirs.make("openclaw-auto-device-capacity-");
        try {
          const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
          const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
          const first = createHarness(database, placements, {
            environmentGeneration: 1,
            destroyFails,
          });
          const second = createHarness(database, placements, { environmentGeneration: 4 });
          const nodes = [connectedNode("first", 2), connectedNode("second", 1)];
          vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
            deviceEnvironments(nodes),
          );
          let firstAllocated = false;
          const availability = async (deviceId: string) => ({
            available: true,
            node:
              deviceId === "first" && firstAllocated
                ? connectedNode("first", 0)
                : nodes.find((node) => node.nodeId === deviceId),
          });
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
                nodeDeviceId: deviceId,
                sshEndpoint: null,
                sharedHost: true,
              };
            });
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
          useDeviceSession();
          dispatchTestMocks.resolveTarget.mockReturnValue(
            makeSessionTarget({
              sessionId: "session-1",
              worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
            }),
          );
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

          expect(first.environments.createWithRequest).toHaveBeenCalledOnce();
          expect(first.environments.attachSession).not.toHaveBeenCalled();
          expect(first.environments.destroy).toHaveBeenCalledOnce();
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
          expect(placements.get("session-1")).toMatchObject({
            state: destroyFails ? "failed" : "active",
          });
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      },
    );

    it("never attempts more than three hosts after they become ineligible", async () => {
      useDeviceSession();
      const nodes = ["first", "second", "third", "fourth"].map((id, index) =>
        connectedNode(id, 4 - index),
      );
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      const disconnected = new Set<string>();
      const workerEnvironmentService = {};
      let failedPlacement: WorkerSessionPlacementRecord | undefined;
      bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) => {
        if (disconnected.has(deviceId)) {
          return { available: false, unavailableReason: "disconnected" };
        }
        return { available: true, node: nodes.find((node) => node.nodeId === deviceId) };
      });
      const dispatch = vi.fn(
        async (
          request: { deviceId?: string },
          report?: (placement: WorkerSessionPlacementRecord) => void,
        ) => {
          const deviceId = request.deviceId!;
          disconnected.add(deviceId);
          failedPlacement = { ...makeFailedPlacement(), environmentId: null };
          report?.(failedPlacement);
          throw new DevicePlacementUnavailableError(
            deviceId,
            `device worker node is not connected: ${deviceId}; reconnect it before retrying`,
          );
        },
      );
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerEnvironmentService: workerEnvironmentService as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: {
            getMany: () =>
              new Map(failedPlacement ? [[dispatchTestSessionId, failedPlacement]] : []),
          },
        }),
        { autoDevice: true },
      );

      expect(dispatch.mock.calls.map(([request]) => request.deviceId)).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: expect.stringMatching(/after 3.*reconnect/i),
        }),
      );
    });

    it.each([
      "workspace synchronization failed",
      "Worker dispatch lost its current node authority before attachment",
    ])("does not retry an unclassified failure: %s", async (message) => {
      useDeviceSession();
      const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      const dispatch = vi.fn().mockRejectedValue(new Error(message));
      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
        { autoDevice: true },
      );

      expect(dispatch).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message,
        }),
      );
    });

    it("never rotates an allocated environment on an unclassified node failure", async () => {
      useDeviceSession();
      const nodes = [connectedNode("first", 3), connectedNode("second", 2)];
      vi.spyOn(environmentMethods, "listGatewayEnvironments").mockResolvedValue(
        deviceEnvironments(nodes),
      );
      let allocated = false;
      const workerEnvironmentService = {};
      bindDeviceWorkerAvailability(workerEnvironmentService, async (deviceId) =>
        allocated && deviceId === "first"
          ? { available: false, unavailableReason: "disconnected" }
          : { available: true, node: nodes.find((node) => node.nodeId === deviceId) },
      );
      const dispatch = vi.fn(async () => {
        allocated = true;
        throw new Error("device worker node is not connected: first; reconnect it before retrying");
      });

      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          nodeRegistry: {
            get: (deviceId: string) => nodes.find((node) => node.nodeId === deviceId),
          } as never,
          workerEnvironmentService: workerEnvironmentService as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: {
            getMany: () =>
              new Map(allocated ? [[dispatchTestSessionId, makeFailedPlacement()]] : []),
          } as never,
        }),
        { autoDevice: true },
      );

      expect(dispatch).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: expect.stringContaining("device worker node is not connected: first"),
        }),
      );
    });
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
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        autoSelection: { providerIds: ["codex", "openai"] },
        cloudPlacement: {
          mode: "remote-exec",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          },
        },
        supports: () => ({ supported: true, priority: 10 }),
        async runAttempt() {
          throw new Error("not used");
        },
      });
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
      },
      {
        name: "declared but denied",
        declaredCommands: ["system.run", "codex.exec-server.stdio.v1"],
        commandPolicy: { deny: ["codex.exec-server.stdio.v1"] },
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
          message: expect.stringMatching(/command.*(enabled|approved|declared)/i),
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
          undefined,
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

    it("carries runtime-owned node command requirements into cloud-profile dispatch", async () => {
      useDeviceSession("codex");
      const dispatch = vi.fn().mockRejectedValue(new Error("cloud-profile dispatch reached"));

      const respond = await invokeSessionDispatch(
        makeDispatchTestContext({
          getRuntimeConfig: () => ({
            cloudWorkers: { profiles: { test: { provider: "multimode-cloud" } } },
            gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
          }),
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
      );

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          executionMode: "remote-exec",
          profileId: "test",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          },
        }),
        expect.any(Function),
        undefined,
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.UNAVAILABLE,
          message: "cloud-profile dispatch reached",
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
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-session-dispatch-device-"),
      );
      try {
        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        const harness = createHarness(database, placements);
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

        const placement = placements.get(dispatchTestSessionId);
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
      } finally {
        closeOpenClawStateDatabaseForTest();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
