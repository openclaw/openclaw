import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  nodeWorkerTurnMatchesIdentity,
  type NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { NodeWorkerPendingAdmission } from "./node-worker-supervisor-ownership.js";

export function nodeWorkerDescriptorSecrets(descriptor: WorkerLaunchDescriptor): string[] {
  const endpoint = descriptor.connectionEndpoint;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  return [
    descriptor.admission.credential,
    ...(access ? [access.clientId, access.clientSecret] : []),
    ...(descriptor.assignment.github ? [descriptor.assignment.github.token] : []),
  ];
}

/** Cancellation starts immediately, then joins the exact admission before returning its receipt. */
export async function joinNodeWorkerTurnCancellation(params: {
  expected: NodeWorkerSupervisorIdentity;
  admissions: ReadonlyMap<string, NodeWorkerPendingAdmission>;
  cancelTurn: () => Promise<NodeWorkerLaunchReceipt | undefined>;
  readReceipt: () => Promise<NodeWorkerLaunchReceipt | undefined>;
}): Promise<NodeWorkerLaunchReceipt | undefined> {
  const admission = [...params.admissions.values()].find((pending) =>
    nodeWorkerTurnMatchesIdentity(pending.identity, params.expected),
  );
  const cancellation = params.cancelTurn();
  if (!admission) {
    return cancellation;
  }
  const [cancelled, admitted] = await Promise.allSettled([cancellation, admission.done]);
  if (cancelled.status === "rejected") {
    throw cancelled.reason;
  }
  if (
    admitted.status === "rejected" &&
    (!admission.signal.aborted || admitted.reason !== admission.signal.reason)
  ) {
    throw admitted.reason;
  }
  return params.readReceipt();
}
