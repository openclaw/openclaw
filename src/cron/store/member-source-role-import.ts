import { isDeepStrictEqual } from "node:util";
import {
  importLegacyMemberSnapshot,
  type LegacyOpenClawIdMemberRoleImport,
} from "../../gateway/openclaw-id/member-source-role-import.js";
import {
  decodeGatewayOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
} from "../../gateway/operator-run-recovery-source.codec.js";
import { resolveMissingOperatorScope } from "../../shared/operator-scope-compat.js";
import { resolveCronOperatorExecutionRevision } from "../service/jobs-tool-policy.js";
import { parseCronStreamSandboxTarget } from "../stream-sandbox-target.js";
import type { CronStoredJob } from "../types.js";

/** Payload, native stream, and sandbox targets retain independent captured grants. */
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
  const target = parseCronStreamSandboxTarget(job.streamSandbox);
  const operator = target?.operator;
  const principal = operator?.openclawIdPrincipal;
  if (
    target &&
    isDeepStrictEqual(target, job.streamSandbox) &&
    operator?.profileId === input.profileId &&
    operator.assignedRole === null &&
    principal?.kind === "member" &&
    principal.accountId === input.accountId &&
    principal.role === input.role &&
    resolveMissingOperatorScope(operator.scopes, input.policy.scopes) === null
  ) {
    // Targets capture the member's assignment, scopes and grant, not a role-policy snapshot.
    next = {
      ...next,
      streamSandbox: { ...target, operator: { ...operator, assignedRole: input.role } },
    };
  }
  if (
    next.streamSandbox !== job.streamSandbox &&
    next.operatorSource &&
    job.operatorSource?.executionRevision === resolveCronOperatorExecutionRevision(job)
  ) {
    next = {
      ...next,
      operatorSource: {
        ...next.operatorSource,
        executionRevision: resolveCronOperatorExecutionRevision(next),
      },
    };
  }
  return next;
}
