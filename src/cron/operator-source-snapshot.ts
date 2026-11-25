import { decodeGatewayOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import type { CronStoredJob } from "./types.js";

/** Decode stored custody before inspecting policy; this is not executable authority. */
export function readCronOperatorSnapshot(job: Pick<CronStoredJob, "operatorSource">) {
  return job.operatorSource
    ? decodeGatewayOperatorRecoverySource(job.operatorSource.source).snapshot
    : undefined;
}
