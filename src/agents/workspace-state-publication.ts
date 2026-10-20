import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "../state/state-domain-publication.js";

// The snapshot cache consumes invalidation, not row or hash postimages.
export const workspaceStatePublication = createStateDomainPublication<true>({
  domain: "workspace-state",
  keyOf: () => "changed",
  isValue: (value): value is true => value === true,
});

export function captureWorkspaceStateReceipt<T>(db: EngineConnection, run: () => T): T {
  const { result, receipt } = workspaceStatePublication.capture(db, run);
  deferSqliteWorkerCommitReceipt(
    db,
    {
      kind: "workspace-state",
      result,
      receipt: workspaceStatePublication.bound(receipt),
    },
    receipt.facts.size === 0 ? "settlement" : "commit",
  );
  return result;
}

export function readWorkspaceStateReceipt(facts: unknown) {
  if (!isRecord(facts) || facts.kind !== "workspace-state") {
    throw new Error("Workspace state has no committed receipt");
  }
  return facts;
}

export function withWorkspaceStatePublication(
  context: OpenClawStateWorkerContext,
  createAdmission: SqliteWorkerAdmissionFactory,
  onCommitted?: (facts: ReturnType<typeof readWorkspaceStateReceipt>) => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const accepted = createAdmission(operation);
    const publication = workspaceStatePublication.begin({
      get identity() {
        return context.admission.identity.key;
      },
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(accepted.admission, ({ facts }) => {
      const receipt = readWorkspaceStateReceipt(facts);
      publication.committed(receipt.receipt);
      onCommitted?.(receipt);
    });
    void operation.settled.then((settlement) =>
      publication.finish(settlement.kind === "completed"),
    );
    return accepted;
  };
}
