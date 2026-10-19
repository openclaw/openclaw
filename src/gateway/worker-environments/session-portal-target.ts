import { captureDedicatedNodeLease } from "./dedicated-node-lease-attestations.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";
import type { WorkerEnvironmentSessionIdentity } from "./session-attachment.js";

/** Captures a dedicated machine target; authorization remains with the session caller. */
export function captureSessionPortalTarget(
  environments: WorkerEnvironmentServiceContract,
  identity: WorkerEnvironmentSessionIdentity,
  environmentId?: string,
) {
  const attachment = environments.captureSessionAttachment(identity);
  const { binding } = attachment;
  const unavailableMessage =
    "Session previews require an attached dedicated cloud worker; shared or unclassified machines cannot expose ports";
  if (environmentId !== undefined && binding.environmentId !== environmentId) {
    throw new Error(unavailableMessage);
  }
  const lease = captureDedicatedNodeLease(
    environments.getDedicatedNodeLeaseSignal,
    binding.environmentId,
    unavailableMessage,
  );
  const assertCurrent = () => {
    lease.assertCurrent();
    attachment.assertCurrent();
    // The provider owner validates the lease/node/epoch tuple; the attachment owner
    // validates its exact generation. Do not duplicate either owner's projection here.
  };
  assertCurrent();
  return { binding, signal: lease.signal, assertCurrent, touch: () => attachment.touch() };
}
