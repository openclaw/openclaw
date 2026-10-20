import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";

export function createNodeWorkerBundleTestNode(): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: "node-1",
    connId: "conn-1",
    pairingIdentity: "pairing-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
    commands: [],
  };
}
