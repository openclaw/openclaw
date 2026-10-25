import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { createChatRunState } from "../server-chat-state.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { createDevicePlacementDemandReader } from "../worker-environments/device-placement-demand.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import { createNodeWorkerBundleTestNode } from "../worker-environments/node-worker-bundle.test-support.js";
import { coordinateWorkerPlacementDispatch } from "../worker-environments/placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  createCoordinatorTestService,
} from "../worker-environments/placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "../worker-environments/placement-dispatch-test-fixtures.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "../worker-environments/service.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import * as environmentMethods from "./environments.js";
import {
  getDispatchTestMocks,
  getSessionDispatchHandler,
  makeDispatchTestContext,
} from "./sessions-dispatch.test-support.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type HeldTurn = Parameters<typeof chatDispatch.startChatDispatch>[0];
type Environment = NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
type DispatchService = NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>;
const dispatchTestMocks = getDispatchTestMocks();

function connectedNode(deviceId: string): NodeWorkerSupervisorNodeProof {
  const node = createNodeWorkerBundleTestNode();
  return {
    ...node,
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    workerHost: {
      ...node.workerHost,
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["system.run"],
  };
}

async function withDemandFixture(
  run: (fixture: {
    dispatch: (sessionId: string, deviceId?: string) => Promise<string>;
    send: (sessionId: string) => Promise<HeldTurn>;
    nodes: NodeWorkerSupervisorNodeProof[];
    placements: Map<string, WorkerSessionPlacementRecord>;
    service: DispatchService;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const sessionRuntime =
      await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
    dispatchTestMocks.resolveTarget.mockImplementation(
      sessionRuntime.resolveGatewaySessionStoreTargetInWorker,
    );
    dispatchTestMocks.findLiveByOwner.mockImplementation((_kind: string, sessionKey: string) => ({
      id: sessionKey,
      ownerKind: "session",
      ownerId: sessionKey,
      path: state.workspaceDir,
    }));
    const nodes = ["node-1", "node-2", "node-3"].map(connectedNode);
    vi.spyOn(environmentMethods, "listGatewayEnvironments").mockImplementation(async () =>
      nodes.map((node): EnvironmentSummary => ({
        id: `node:${node.nodeId}`,
        type: "node",
        status: "available",
        sessionHost: true,
        workerSlots: { ...node.workerHost.capacity },
      })),
    );
    const placements = new Map<string, WorkerSessionPlacementRecord>();
    const environments = new Map<string, Environment>();
    const placementReader = {
      prepareSessionPlacement: async (sessionId: string) => {
        let released = false;
        return {
          prepareRead: () => undefined,
          current: () => {
            if (released) {
              throw new Error("Worker placement observation is no longer current");
            }
            return placements.get(sessionId);
          },
          release: () => {
            released = true;
          },
        };
      },
      getMany: (ids: readonly string[]) =>
        new Map(ids.filter((id) => placements.has(id)).map((id) => [id, placements.get(id)!])),
    };
    const environmentService = {
      get: (id: string) => environments.get(id),
      readMachineShape: () => undefined,
      supportsExecutionMode: () => true,
    };
    bindDeviceWorkerAvailability(environmentService, async (deviceId) => ({
      available: true,
      node: nodes.find((node) => node.nodeId === deviceId),
    }));
    const service: DispatchService = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (request) => {
          const deviceId = expectDefined(request.deviceId, "selected device");
          const placement: WorkerSessionPlacementRecord = {
            ...ACTIVE_PLACEMENT,
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            environmentId: `worker:${request.sessionId}`,
          };
          placements.set(request.sessionId, placement);
          environments.set(placement.environmentId, {
            ...createDispatchEnvironmentFixtures().attached,
            environmentId: placement.environmentId,
            providerId: "device",
            nodeDeviceId: deviceId,
            ownerEpoch: placement.activeOwnerEpoch,
            attachedSessionIds: [placement.sessionId],
          });
          return placement;
        },
      }),
      async (_request, dispatch) => await dispatch(),
    );
    const context = makeDispatchTestContext({
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      getRuntimeConfig,
      addChatRun: vi.fn(),
      broadcastToConnIds: vi.fn(),
      logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      nodeRegistry: { get: (id: string) => nodes.find((node) => node.nodeId === id) } as never,
      workerEnvironmentService: environmentService as never,
      workerSessionPlacementService: placementReader,
      workerPlacementDispatchService: service,
    });
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
    service.getAdmittedDeviceSessionCounts = createDevicePlacementDemandReader({
      resolveGatewayContext,
      placements: placementReader,
      environments: environmentService,
    });
    const client: GatewayClient = {
      connId: "demand-operator",
      connect: gatewayConnect(["operator.read", "operator.write", "operator.admin"], {
        id: "cli",
        mode: "cli",
      }),
    };
    const heldTurns = new Map<string, HeldTurn>();
    // Preserve the real admission/ACK; the simulated node has not published a physical launch yet.
    vi.spyOn(chatDispatch, "startChatDispatch").mockImplementation(async (turn) => {
      heldTurns.set(turn.session.entry!.sessionId, turn);
    });
    const sessionKey = (id: string) => `agent:main:${id}`;
    const invoke = async (
      operation: "dispatch" | "send",
      sessionId: string,
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      const method = `sessions.${operation}` as const;
      const handler =
        operation === "dispatch"
          ? getSessionDispatchHandler()
          : expectDefined(sessionMessagingHandlers[method], method);
      await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
        handler({
          req: { type: "req", id: `${operation}:${sessionId}`, method },
          params: { key: sessionKey(sessionId), ...params },
          respond,
          context,
          client,
          isWebchatConnect: () => false,
        }),
      );
      return respond;
    };
    const dispatch = async (sessionId: string, deviceId?: string) => {
      const key = sessionKey(sessionId);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId,
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          worktree: { id: key, branch: "test", repoRoot: state.workspaceDir },
        },
      );
      const respond = await invoke(
        "dispatch",
        sessionId,
        deviceId ? { deviceId } : { autoDevice: true },
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          placement: expect.objectContaining({ state: "active" }),
        }),
        undefined,
      );
      const placement = expectDefined(placements.get(sessionId), "completed placement");
      const environment = expectDefined(environments.get(placement.environmentId!), "environment");
      return expectDefined(environment.nodeDeviceId, "placed node");
    };
    const send = async (sessionId: string) => {
      const respond = await invoke("send", sessionId, {
        message: "Run the node workload",
        idempotencyKey: `run:${sessionId}`,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: `run:${sessionId}`, status: "started" }),
        undefined,
        expect.anything(),
      );
      return expectDefined(heldTurns.get(sessionId), "admitted session turn");
    };
    try {
      for (const [index, node] of nodes.entries()) {
        const id = `explicit-${index + 1}`;
        expect(await dispatch(id, node.nodeId)).toBe(node.nodeId);
        await send(id);
      }
      nodes[0]!.workerHost.capacity = { total: 2, available: 1 };
      nodes[1]!.workerHost.capacity = { total: 2, available: 1 };
      await run({ dispatch, send, nodes, placements, service });
    } finally {
      for (const turn of heldTurns.values()) {
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
    }
  });
}

describe("sessions.dispatch after admitted sessions.send", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("spreads later Auto work while a completed dispatch awaits physical slot publication", async () => {
    await withDemandFixture(async ({ dispatch, send, nodes, placements, service }) => {
      expect(await dispatch("auto-04")).toBe("node-3");
      await send("auto-04");
      expect(service.getPendingDeviceDispatchCount?.("node-3")).toBe(0);
      expect(placements.get("auto-04")?.turnClaim).toBeNull();
      expect(nodes.map((node) => node.workerHost.capacity.available)).toEqual([1, 1, 2]);

      expect(await dispatch("auto-05")).toBe("node-1");
      await send("auto-05");
      expect(await dispatch("auto-06")).toBe("node-2");
    });
  });

  it("does not reserve capacity for a retained placement after admission is released", async () => {
    await withDemandFixture(async ({ dispatch, send, placements }) => {
      expect(await dispatch("auto-04")).toBe("node-3");
      const turn = await send("auto-04");
      turn.admission.cleanupAdmittedRun();
      expect(placements.get("auto-04")?.state).toBe("active");
      expect(await dispatch("auto-05")).toBe("node-3");
    });
  });
});
