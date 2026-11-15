import { decodeGatewayOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import { CronOperatorSourceError } from "./operator-source-error.js";
import type { CronStoredJob } from "./types.js";

/** Decode stored custody before inspecting policy; this is not executable authority. */
export function readCronOperatorSnapshot(job: Pick<CronStoredJob, "operatorSource">) {
  return job.operatorSource
    ? decodeGatewayOperatorRecoverySource(job.operatorSource.source).snapshot
    : undefined;
}

/** A refused stored source is permanent, even before an isolated run creates its session. */
export function readCronOperatorSnapshotForRun(job: Pick<CronStoredJob, "operatorSource">) {
  try {
    return readCronOperatorSnapshot(job);
  } catch (error) {
    throw new CronOperatorSourceError(error);
  }
}
