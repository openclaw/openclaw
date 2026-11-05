import { normalizeGatewayOperatorRecoverySnapshot } from "../gateway/operator-run-recovery-source.codec.js";
import { cronUpdateRequiresStreamExecAuthority } from "./stream-exec-authority.js";
import type { CronStoredJob } from "./types.js";

/** Canonicalize the private native process grant with the existing bounded recovery codec. */
export function decodeCronStreamOperatorSource(value: unknown) {
  const snapshot = normalizeGatewayOperatorRecoverySnapshot(value);
  if (!snapshot) {
    throw new TypeError("Invalid native stream operator source; reauthorize the stream.");
  }
  return snapshot;
}

/** Only existing stream-exec edges replace the process grant; payload edits retain it. */
export function applyCronStreamOperatorSource(params: {
  job: CronStoredJob;
  previousJob?: CronStoredJob;
  source?: CronStoredJob["streamOperatorSource"];
  patch: Record<string, unknown>;
}): void {
  const { job, previousJob, source, patch } = params;
  if (job.schedule.kind !== "stream" || job.streamSandbox) {
    delete job.streamOperatorSource;
    return;
  }
  if (
    source !== undefined &&
    (!previousJob || cronUpdateRequiresStreamExecAuthority(patch, previousJob))
  ) {
    job.streamOperatorSource = decodeCronStreamOperatorSource(source);
  }
}
