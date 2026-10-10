import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "../state/state-domain-publication.js";
import { parsePersistedExecApprovals } from "./exec-approvals-config.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "./sqlite-worker-operation-admission.js";

export type ExecApprovalsPublicationValue = {
  file: Omit<ExecApprovalsFile, "socket">;
  change: "policy" | "usage";
};

/** Socket credentials are transport state, never part of an authority publication. */
export const execApprovalsPublication = createStateDomainPublication<ExecApprovalsPublicationValue>(
  {
    domain: "exec-approvals",
    keyOf: () => "current",
    isValue: (value): value is ExecApprovalsPublicationValue =>
      isRecord(value) &&
      (value.change === "policy" || value.change === "usage") &&
      isRecord(value.file) &&
      !Object.hasOwn(value.file, "socket") &&
      parsePersistedExecApprovals(JSON.stringify(value.file)).ok,
  },
);

export function withExecApprovalsPublication(
  createAdmission: (
    operation: Parameters<SqliteWorkerAdmissionFactory>[0],
    onCommitAdmitted: () => void,
  ) => ReturnType<SqliteWorkerAdmissionFactory>,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    let commitAdmitted = false;
    const retained = createAdmission(operation, () => {
      commitAdmitted = true;
    });
    const { admission } = retained;
    let publication: ReturnType<typeof execApprovalsPublication.begin> | undefined;
    admission.observeRequests((request) => {
      if (request.stage === "transaction") {
        publication = execApprovalsPublication.begin({
          identity: context.admission.identity.key,
          assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
        });
      }
    });
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      publication?.committed(isRecord(facts) ? facts.execFacts : undefined);
    });
    const finish = admission.finish.bind(admission);
    admission.finish = () => {
      try {
        finish();
      } finally {
        const confirmed = admission.settlement?.kind === "completed";
        publication?.finish(confirmed, confirmed && !admission.committed && !commitAdmitted);
      }
    };
    return retained;
  };
}
