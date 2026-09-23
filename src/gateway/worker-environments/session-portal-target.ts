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
  const environment = environments.get(binding.environmentId);
  const signal = environments.getDedicatedNodeLeaseSignal(binding.environmentId);
  if (
    !environment ||
    (environmentId !== undefined && binding.environmentId !== environmentId) ||
    !environment.leaseId ||
    !environment.nodeDeviceId ||
    environment.sharedHost !== false ||
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
    const current = environments.get(binding.environmentId);
    if (
      environments.getDedicatedNodeLeaseSignal(binding.environmentId) !== signal ||
      current?.leaseId !== environment.leaseId ||
      current.nodeDeviceId !== environment.nodeDeviceId ||
      current.ownerEpoch !== binding.ownerEpoch
    ) {
      throw new Error("Session preview machine ownership changed");
    }
  };
  assertCurrent();
  return { binding, signal, assertCurrent, touch: () => attachment.touch() };
}
