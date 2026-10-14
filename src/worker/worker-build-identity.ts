import {
  type WorkerAdmissionHandshake,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";

export type ExpectedWorkerBuild = {
  bundleHash: WorkerAdmissionHandshake["bundleHash"];
  openclawVersion: WorkerAdmissionHandshake["openclawVersion"];
  protocolFeatures: readonly string[];
};

/** Fence persisted builds that cannot parse the exact current launch descriptor. */
export function supportsCurrentWorkerLaunch(
  handshake: Pick<WorkerAdmissionHandshake, "protocolFeatures"> | null | undefined,
): boolean {
  return (
    handshake?.protocolFeatures.includes(WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE) === true &&
    handshake.protocolFeatures.includes(WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE)
  );
}

export function sameWorkerProtocolFeatures(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = left.toSorted();
  const normalizedRight = right.toSorted();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

/** Compares the exact worker build while treating protocol features as an unordered set. */
export function sameWorkerBuild(left: ExpectedWorkerBuild, right: ExpectedWorkerBuild): boolean {
  return (
    left.bundleHash === right.bundleHash &&
    left.openclawVersion === right.openclawVersion &&
    sameWorkerProtocolFeatures(left.protocolFeatures, right.protocolFeatures)
  );
}
