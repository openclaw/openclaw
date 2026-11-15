import type { AgentToolResult } from "../../agents/runtime/index.js";
import { formatPortalResult } from "../../agents/tools/portal-tool.js";
import { createPortalOperations, type GatewayPortalService } from "../portals/portal-service.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionToolRequest } from "./worker-session-tool-result.js";
import type { WorkerSessionToolSource } from "./worker-session-tool-topology.js";

type WorkerPortalToolRequest = Extract<WorkerSessionToolRequest, { toolName: "portal" }>;

export type WorkerPortalToolExecutorDependencies = {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  portals: {
    getService: () => GatewayPortalService | undefined;
    carrier: Pick<WorkerNodePortalCarrier, "open">;
    onChanged: () => void;
  };
};

/** Executes worker portals only while their exact placement and turn retain authority. */
export function createWorkerPortalToolExecutor(params: WorkerPortalToolExecutorDependencies) {
  return async (
    request: WorkerPortalToolRequest,
    source: Pick<WorkerSessionToolSource, "sessionId" | "turnClaim">,
    assertSource: () => void,
  ): Promise<AgentToolResult<unknown>> => {
    const assertPortalAuthority = () => {
      assertSource();
      if (!params.placements.isWorkerTurnToolAuthorized(source.turnClaim, "portal")) {
        throw new Error("Worker session tool authority changed");
      }
      const environment = params.environments.get(request.identity.environmentId);
      if (
        !environment ||
        environment.state !== "attached" ||
        environment.ownerEpoch !== request.identity.ownerEpoch ||
        environment.attachedSessionIds.length !== 1 ||
        environment.attachedSessionIds[0] !== source.sessionId
      ) {
        throw new Error("Worker source environment changed before portal operation");
      }
      if (!environment.nodeDeviceId || environment.sshEndpoint !== null) {
        throw new Error(
          "Portals require a node-backed cloud-worker placement; move the session back to the gateway with sessions.move",
        );
      }
      return environment;
    };
    const environment = assertPortalAuthority();
    const service = params.portals.getService();
    if (!service) {
      throw new Error("Gateway portals are unavailable");
    }
    request.signal?.throwIfAborted();
    const portals = createPortalOperations(
      service,
      {
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        assertCurrent: () => {
          assertPortalAuthority();
          request.signal?.throwIfAborted();
        },
        ownershipError: "Worker portal is not owned by the active environment",
        prepareTarget: async (remotePort) => ({
          ...(await params.portals.carrier.open({
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
            remotePort,
          })),
          origin: environment.profileId,
        }),
      },
      params.portals.onChanged,
    );
    if (request.request.action === "list") {
      return formatPortalResult({ action: "list", result: portals.list() });
    }
    if (request.request.action === "close") {
      const id = request.request.id;
      if (!id) {
        throw new Error("portal id required");
      }
      return formatPortalResult({ action: "close", id, result: await portals.close(id) });
    }
    const remotePort = request.request.port;
    if (remotePort === undefined) {
      throw new Error("portal port required");
    }
    return formatPortalResult({
      action: "open",
      result: await portals.open({ ...request.request, port: remotePort }),
    });
  };
}
