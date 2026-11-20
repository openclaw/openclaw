import { getGatewayResourceProfile } from "../../infra/gateway-resource-profile.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";

/** Read the Gateway's owner and existing heap samples, without adding a sampler or starting workers. */
export function readGatewayResourceDiagnostics() {
  const profile = getGatewayResourceProfile();
  if (!profile) {
    return undefined;
  }
  const memory = getTrackedWorkerPoolSnapshot();
  return {
    ...profile,
    workerCount: memory.workerCount,
    workerMemoryScope: memory.workerMemoryScope,
    workerHeapSampledCount: memory.workerHeapSampledCount,
    workerCensus: memory.workerCensus,
  };
}
