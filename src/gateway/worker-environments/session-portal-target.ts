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
  const signal = environments.getDedicatedNodeLeaseSignal(binding.environmentId);
  if (
    (environmentId !== undefined && binding.environmentId !== environmentId) ||
    !signal ||
    signal.aborted
  ) {
    throw new Error(
      "Session previews require an attached dedicated cloud worker; shared or unclassified machines cannot expose ports",
    );
  }
  const assertCurrent = () => {
    signal.throwIfAborted();
    attachment.assertCurrent();
    // The provider owner validates the lease/node/epoch tuple; the attachment owner
    // validates its exact generation. Do not duplicate either owner's projection here.
    if (environments.getDedicatedNodeLeaseSignal(binding.environmentId) !== signal) {
      throw new Error("Session preview machine ownership changed");
    }
  };
  assertCurrent();
  return { binding, signal, assertCurrent, touch: () => attachment.touch() };
}
