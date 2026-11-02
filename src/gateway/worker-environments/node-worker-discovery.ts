import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

/** Resolve the connected supervisor without retaining a stale transport across reconnects. */
export async function findNodeWorker(params: {
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  deviceId: string;
  signal: AbortSignal;
}) {
  const transport = params.getTransport();
  if (!transport) {
    throw new Error("device worker node transport is unavailable");
  }
  const node = await raceNodeWorkerOperation(
    transport.getCurrentNode(params.deviceId),
    params.signal,
  );
  if (!node) {
    throw new WorkerTunnelOwnerDisconnectedError(
      "device worker node is not connected with the supervisor dialect",
    );
  }
  return { transport, node };
}
