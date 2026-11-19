import { isDeepStrictEqual } from "node:util";
import {
  importLegacyMemberSnapshot,
  type LegacyOpenClawIdMemberRoleImport,
} from "../../gateway/openclaw-id/member-source-role-import.js";
import {
  decodeGatewayOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
} from "../../gateway/operator-run-recovery-source.codec.js";
import type { CronStoredJob } from "../types.js";

/** The payload and native stream sources are independent captured grants. */
export function importLegacyCronMemberSources(
  job: CronStoredJob,
  input: LegacyOpenClawIdMemberRoleImport,
): CronStoredJob {
  let next = job;
  if (job.operatorSource) {
    try {
      const source = decodeGatewayOperatorRecoverySource(job.operatorSource.source);
      const snapshot = isDeepStrictEqual(source, job.operatorSource.source)
        ? importLegacyMemberSnapshot(job.operatorSource.source.snapshot, input)
        : job.operatorSource.source.snapshot;
      if (snapshot !== job.operatorSource.source.snapshot) {
        next = {
          ...next,
          operatorSource: {
            ...job.operatorSource,
            source: { ...job.operatorSource.source, snapshot },
          },
        };
      }
    } catch {
      // Malformed authority remains unavailable, not repaired from fresh admission.
    }
  }
  const stream = normalizeGatewayOperatorRecoverySnapshot(job.streamOperatorSource);
  if (stream && isDeepStrictEqual(stream, job.streamOperatorSource)) {
    const snapshot = importLegacyMemberSnapshot(job.streamOperatorSource!, input);
    if (snapshot !== job.streamOperatorSource) {
      next = { ...next, streamOperatorSource: snapshot };
    }
  }
  return next;
}
