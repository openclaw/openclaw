import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertSessionEntryCurrentAdmission } from "../../config/sessions/session-entry-current-admission.js";
import { operatorApprovalPublication } from "../../gateway/operator-approval-store.publication.js";
import type { OperatorApprovalRecord } from "../../gateway/operator-approval-store.types.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { CronStreamMutationAdmissionFacts } from "../store/runtime-worker.types.js";
import {
  cronStreamExecApprovalBinding,
  type CronStreamExecMutation,
} from "../stream-exec-authority.js";
import type { CronAddOptions } from "./state.js";

/** Revalidate captured creator sessions at commit; only stream callers supply exec policy. */
export function prepareCronStreamMutationAdmission(params: {
  context: OpenClawStateWorkerContext;
  authority: Pick<CronAddOptions, "execPolicy" | "sessionEntryCurrent" | "streamExecApproval">;
  assertCurrent: () => void;
}) {
  const { context, authority } = params;
  const approval = authority.streamExecApproval;
  if (approval && approval.consumption.databasePath !== context.admission.databasePath) {
    throw new TypeError("Stream approval belongs to a different state database.");
  }
  let mutation: CronStreamExecMutation | undefined;
  const createAdmission: SqliteWorkerAdmissionFactory = (operation) => {
    let commitAdmitted = false;
    const retained = createSqliteWorkerWriteAdmission(
      (nativeRequest) => {
        context.admission.assertCurrent();
        params.assertCurrent();
        const request = assertSessionEntryCurrentAdmission(
          nativeRequest,
          authority.sessionEntryCurrent,
        );
        if (!isRecord(request.facts) || !isRecord(request.facts.mutation)) {
          throw new Error("Stream mutation has no transaction-held job definition");
        }
        // SAFETY: the private native request is produced only by the cron job mutation owner.
        const facts = request.facts as CronStreamMutationAdmissionFacts;
        mutation = facts.mutation;
        // A transaction-proven unchanged declaration needs no new execution consent.
        if (!facts.unchangedDeclaration) {
          const approvedPolicyKey =
            approval?.binding === cronStreamExecApprovalBinding(mutation)
              ? approval.policyKey
              : undefined;
          if (approvedPolicyKey !== undefined) {
            approval!.consumption.assertCurrent();
          }
          const policy = authority.execPolicy;
          if (policy?.kind === "needs-approvals") {
            if (!facts.execApprovals) {
              throw new Error("Stream mutation has no transaction-held exec policy");
            }
            policy.assertCurrent(facts.execApprovals, approvedPolicyKey);
          } else {
            policy?.assertCurrent(approvedPolicyKey);
          }
        }
        authority.execPolicy?.assertCurrentSource?.();
        params.assertCurrent();
        if (request.stage === "commit") {
          commitAdmitted = true;
        }
      },
      [
        context.admission.databasePath,
        ...(authority.sessionEntryCurrent ? [authority.sessionEntryCurrent.source.path] : []),
      ],
    )(operation);
    const publication = operatorApprovalPublication.begin({
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    const { admission } = retained;
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      publication.committed(isRecord(facts) ? facts.approvalFacts : undefined);
      if (approval && isRecord(facts) && isRecord(facts.consumedStreamApproval)) {
        // SAFETY: the native transition decoded this record; the waiter verifies its exact owner.
        approval.consumption.markCommitted(facts.consumedStreamApproval as OperatorApprovalRecord);
      }
    });
    observeSqliteWorkerAdmissionFinish(admission, () => {
      const confirmed = admission.settlement?.kind === "completed";
      publication.finish(confirmed, confirmed && !admission.committed && !commitAdmitted);
    });
    return retained;
  };
  return { createAdmission, mutation: () => mutation };
}
