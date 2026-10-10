import type { DatabaseSync } from "node:sqlite";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import { applyExecAuthorizationCommit } from "./exec-approvals-authorization.kernel.js";
import { resolveExecApprovalsDisplayPath } from "./exec-approvals-config.js";
import type {
  ExecAuthorizationCommitInput,
  ExecAuthorizationCommitOutcome,
} from "./exec-approvals-contracts.js";
import type { ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import { assertNoPendingLegacyExecApprovals } from "./exec-approvals-migration-gate.js";
import { execPolicyMutationOperations } from "./exec-approvals-mutation.worker.js";
import { assertExecApprovalsHostPolicyUnchanged } from "./exec-approvals-policy.js";
import { execApprovalsPublication } from "./exec-approvals-publication.js";
import { execApprovalRetirementOperations } from "./exec-approvals-retirement.worker.js";
import {
  snapshotFromExecApprovalsDatabase,
  assertExecApprovalsMutationAllowed,
  ExecApprovalsMutationFencedError,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

function applyAuthorizationBatch(
  db: DatabaseSync,
  initial: ExecApprovalsSnapshot,
  items: readonly ExecAuthorizationCommitInput[],
) {
  let current = initial;
  const outcomes = items.map((item): ExecAuthorizationCommitOutcome => {
    let next: ReturnType<typeof applyExecAuthorizationCommit>;
    try {
      next = applyExecAuthorizationCommit(structuredClone(current.file), item);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (next !== null) {
      assertExecApprovalsHostPolicyUnchanged(current.file, next);
      try {
        assertExecApprovalsMutationAllowed({ db, current: current.file, next });
      } catch (error) {
        if (!(error instanceof ExecApprovalsMutationFencedError)) {
          throw error;
        }
        return { ok: false, message: error.message };
      }
      const raw = serializeExecApprovals(next);
      if (!current.exists || current.raw !== raw) {
        current = snapshotFromExecApprovalsRow({ path: current.path, row: { raw_json: raw } });
      }
    }
    return { ok: true, snapshot: current };
  });
  return { snapshot: current, outcomes };
}

export function commitExecAuthorizationsInWorker(
  input: { items: ExecAuthorizationCommitInput[] },
  context: WorkerWriteOperationContext,
): ExecAuthorizationCommitOutcome[] {
  const options = context.stateOptions();
  assertNoPendingLegacyExecApprovals({ env: options.env });
  const displayPath = resolveExecApprovalsDisplayPath(options.env);
  const mayWrite = input.items.some(
    (item) =>
      item.matches.length > 0 ||
      (item.allowAlwaysDecision !== undefined && item.allowAlwaysDecision.kind !== "one-shot"),
  );
  if (!mayWrite) {
    const { db } = context.open();
    return applyAuthorizationBatch(
      db,
      snapshotFromExecApprovalsDatabase(db, displayPath),
      input.items,
    ).outcomes;
  }
  return context.write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const captured = execApprovalsPublication.capture(db, () => {
        const current = snapshotFromExecApprovalsDatabase(db, displayPath);
        const committed = applyAuthorizationBatch(db, current, input.items);
        if (committed.snapshot.raw !== current.raw) {
          writeExecApprovalsConfigRow({
            db,
            file: committed.snapshot.file,
            raw: committed.snapshot.raw ?? undefined,
            change: input.items.some(
              (item, index) =>
                committed.outcomes[index]?.ok &&
                item.allowAlwaysDecision &&
                item.allowAlwaysDecision.kind !== "one-shot",
            )
              ? "policy"
              : "usage",
          });
        }
        return committed;
      });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      deferSqliteWorkerCommitReceipt(
        db,
        { execFacts: execApprovalsPublication.bound(captured.receipt) },
        captured.receipt.facts.size ? "commit" : "settlement",
      );
      return captured.result.outcomes;
    },
    { operationLabel: "exec-approvals.commit-authorizations" },
  );
}

export const execAuthorizationOperations = {
  ...execApprovalRetirementOperations,
  ...execPolicyMutationOperations,
  "execApprovals.commitAuthorizations": commitExecAuthorizationsInWorker,
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
