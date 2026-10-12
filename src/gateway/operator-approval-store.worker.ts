import { execApprovalsPublication } from "../infra/exec-approvals-publication.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../state/worker-operation-registry.js";
import type { CronStandingGrantRecord } from "./operator-approval-standing-grants.types.js";
import * as grants from "./operator-approval-standing-grants.worker.js";
import * as store from "./operator-approval-store.kernel.worker.js";
import {
  operatorApprovalPublication,
  operatorStandingGrantPublication,
} from "./operator-approval-store.publication.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";
import * as transitions from "./operator-approval-store.transitions.worker.js";

type OperatorApprovalCommitReceipt = {
  type?: "operatorApprovals.resolve";
  resolutionKey?: string;
  grantUse?: CronStandingGrantRecord;
  approvalFacts?: ReturnType<typeof operatorApprovalPublication.bound>;
  standingGrantFacts?: ReturnType<typeof operatorStandingGrantPublication.bound>;
  execFacts?: ReturnType<typeof execApprovalsPublication.bound>;
};
type Context = Pick<WorkerOperationContext, "open" | "stateOptions">;
type Input<Handler extends (input: never) => unknown> = Omit<
  NonNullable<Parameters<Handler>[0]>,
  "databaseOptions"
>;

function transact<Payload, Result>(
  input: Payload,
  context: Context,
  apply: (input: Payload & { databaseOptions: OpenClawStateDatabaseOptions }) => Result,
  receiptOf?: (result: Result) => OperatorApprovalCommitReceipt | undefined,
): Result {
  const options = { ...context.stateOptions(), database: context.open() };
  return runOpenClawStateWriteTransaction((database) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    const approval = operatorApprovalPublication.capture(database.db, () =>
      operatorStandingGrantPublication.capture(database.db, () =>
        execApprovalsPublication.capture(database.db, () =>
          apply({ ...input, databaseOptions: { ...options, database } }),
        ),
      ),
    );
    const standing = approval.result;
    const exec = standing.result;
    const result = exec.result;
    const receipt = {
      ...receiptOf?.(result),
      approvalFacts: operatorApprovalPublication.bound(approval.receipt),
      standingGrantFacts: operatorStandingGrantPublication.bound(standing.receipt),
      execFacts: execApprovalsPublication.bound(exec.receipt),
    };
    const changed =
      approval.receipt.facts.size + standing.receipt.facts.size + exec.receipt.facts.size > 0;
    deferSqliteWorkerCommitReceipt(
      database.db,
      receipt,
      changed || receipt.resolutionKey || receipt.grantUse ? "commit" : "settlement",
    );
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    return result;
  }, options);
}

export const operatorApprovalOperations = {
  "operatorApprovals.insert": (
    input: Input<typeof store.insertOperatorApprovalInDatabase>,
    context,
  ) => transact(input, context, store.insertOperatorApprovalInDatabase),
  "operatorApprovals.get": (
    input: Input<typeof store.getOperatorApprovalDetailedInDatabase>,
    context,
  ) => transact(input, context, store.getOperatorApprovalDetailedInDatabase),
  "operatorApprovals.pending": (
    input: Input<typeof store.listPendingOperatorApprovalsInDatabase>,
    context,
  ) => transact(input, context, store.listPendingOperatorApprovalsInDatabase),
  "operatorApprovals.resolve": (
    input: Input<typeof transitions.resolveOperatorApprovalInDatabase>,
    context,
  ) =>
    transact(input, context, transitions.resolveOperatorApprovalInDatabase, (result) =>
      result.outcome === "resolved"
        ? {
            type: "operatorApprovals.resolve",
            resolutionKey: getOperatorApprovalResolutionKey(result.record),
          }
        : undefined,
    ),
  "operatorApprovals.deny": (
    input: Input<typeof transitions.forceDenyOperatorApprovalInDatabase>,
    context,
  ) => transact(input, context, transitions.forceDenyOperatorApprovalInDatabase),
  "operatorApprovals.expire": (
    input: Input<typeof transitions.expireDueOperatorApprovalsInDatabase>,
    context,
  ) => transact(input, context, transitions.expireDueOperatorApprovalsInDatabase),
  "operatorApprovals.consume": (
    input: Input<typeof transitions.consumeOperatorApprovalAllowOnceInDatabase>,
    context,
  ) => transact(input, context, transitions.consumeOperatorApprovalAllowOnceInDatabase),
  "operatorApprovals.consumeCronGrant": (
    input: Input<typeof grants.consumeCronStandingGrantInDatabase>,
    context,
  ) =>
    transact(input, context, grants.consumeCronStandingGrantInDatabase, (result) =>
      result.outcome === "consumed" ? { grantUse: result.grant } : undefined,
    ),
  "operatorApprovals.revokeCronGrant": (
    input: Input<typeof grants.revokeCronStandingGrantInDatabase>,
    context,
  ) => transact(input, context, grants.revokeCronStandingGrantInDatabase),
} satisfies Record<string, (input: never, context: Context) => unknown>;
