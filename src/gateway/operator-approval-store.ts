import { serialize } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerInputPreparation } from "../infra/sqlite-worker-broker.types.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
// Runtime approval operations retain the shared-state owner through worker settlement.
import {
  createSqliteWorkerWriteAdmission,
  reserveSqliteWorkerInputPreparation,
} from "../infra/sqlite-worker-store.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperationOptions } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { decodeOperatorApprovalHistoryCursor } from "./operator-approval-store.rows.js";
import type {
  ListTerminalOperatorApprovalsInput,
  ListTerminalOperatorApprovalsResult,
  OperatorApprovalStoreGuard,
} from "./operator-approval-store.types.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

export type {
  OperatorApprovalKind,
  OperatorApprovalStatus,
  OperatorApprovalTerminalReason,
  OperatorApprovalResolver,
  OperatorApprovalRecord,
  ResolveOperatorApprovalResult,
  ForceDenyOperatorApprovalResult,
} from "./operator-approval-store.types.js";
export {
  OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS,
  OperatorApprovalHistoryCursorError,
} from "./operator-approval-store.rows.js";
export {
  // Connection-bound receipt readers execute inside the audit read worker.
  hasOperatorApprovalReceiptsForRunInDatabase,
  summarizeOperatorApprovalReceiptsForRunInDatabase,
  pageOperatorApprovalReceiptsForRunInDatabase,
} from "./operator-approval-store.receipts.js";
export {
  // Gateway boot admission closes orphaned rows and prunes before serving requests.
  closeOrphanedOperatorApprovals,
  pruneTerminalOperatorApprovals,
} from "./operator-approval-store.transitions.js";

/** Storage admission failure is not evidence that a pending row is corrupt. */
export function isOperatorApprovalStoreRefusal(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (cause) =>
      isStateDatabaseReadAdmissionInvalidatedError(cause) ||
      ["closed", "overloaded", "unavailable"].includes(extractErrorCode(cause) ?? ""),
  );
}

export function isOperatorApprovalStoreOutcomeUnknown(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (cause) => extractErrorCode(cause) === "outcome-unknown",
  );
}

type Operation = keyof OperatorApprovalWorkerOperations;
type Options = {
  databaseOptions?: OpenClawStateDatabaseOptions;
  assertCurrent?: () => void;
  guard?: OperatorApprovalStoreGuard;
};
type Input<Key extends Operation> = OperatorApprovalWorkerOperations[Key]["input"] & Options;

const loadNativeStore = createLazyRuntimeModule(
  () => import("./operator-approval-store.native.js"),
);
const leases = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.operatorApprovalStoreLeases"));

async function runApprovalStoreOperation<T>(
  context: OpenClawStateWorkerContext,
  input: unknown,
  operation: (
    scope: Pick<SqliteWorkerStore<OperatorApprovalWorkerOperations>, "execute">,
    preparation: SqliteWorkerInputPreparation,
  ) => Promise<T>,
  options?: Omit<OpenClawStateWorkerOperationOptions, "existingOnly">,
  assertCurrent?: () => void,
): Promise<T> {
  context.admission.assertCurrent();
  const preparation = reserveSqliteWorkerInputPreparation(serialize(input).byteLength);
  const lease = expectDefined(
    leases.reserve([
      context.admission.identity.key,
      `path:${context.admission.identity.canonicalPath}`,
    ]),
    "Operator approval storage lease",
  );
  try {
    // Acquire FIFO before retaining an actor: a predecessor may need to retire it.
    await lease.wait();
    preparation.assertCurrent();
    context.admission.assertCurrent();
    assertCurrent?.();
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => operation(scope, preparation),
      options,
    );
  } finally {
    preparation.release();
    lease.release();
  }
}

function execute<Key extends Operation>(
  type: Key,
  input: OperatorApprovalWorkerOperations[Key]["input"],
  { databaseOptions, assertCurrent, guard }: Options,
  onCommitted?: (resolutionKey: string) => void,
): Promise<OperatorApprovalWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  const captured = structuredClone(input);
  const assertOperationCurrent = () => {
    context.admission.assertCurrent();
    guard?.assertCurrent();
    assertCurrent?.();
  };
  const native = guard?.family === "native-compatibility";
  let admission: SqliteWorkerOperationAdmission | undefined;
  const createWriteAdmission = createSqliteWorkerWriteAdmission(assertOperationCurrent, [
    context.admission.databasePath,
  ]);
  const createAdmission: SqliteWorkerAdmissionFactory = (operation) => {
    const retained = createWriteAdmission(operation);
    admission = retained.admission;
    return retained;
  };
  const publishCommitted = (facts: unknown) => {
    if (
      onCommitted &&
      isRecord(facts) &&
      facts.type === "operatorApprovals.resolve" &&
      typeof facts.resolutionKey === "string"
    ) {
      onCommitted(facts.resolutionKey);
    }
  };
  return runApprovalStoreOperation(
    context,
    captured,
    async (scope, preparation) => {
      if (native) {
        const store = await loadNativeStore();
        preparation.assertCurrent();
        assertOperationCurrent();
        preparation.release();
        return store.executeNativeOperatorApproval(
          type,
          captured,
          context,
          assertOperationCurrent,
          onCommitted ? publishCommitted : undefined,
        );
      }
      try {
        return await preparation.handoff(() => scope.execute({ type, input: captured }));
      } finally {
        // Broker settlement retains the native receipt even when the command reply is lost.
        publishCommitted(admission?.committed?.facts);
      }
    },
    {
      // Native guards run only after FIFO and outside worker-held transactions.
      assertCurrent: native ? undefined : assertOperationCurrent,
      ...(native ? {} : { createAdmission }),
    },
    assertOperationCurrent,
  );
}

export function insertOperatorApproval(params: Input<"operatorApprovals.insert">) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return execute("operatorApprovals.insert", input, { databaseOptions, assertCurrent, guard });
}
export function getOperatorApprovalDetailed(params: Input<"operatorApprovals.get">) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return execute("operatorApprovals.get", input, { databaseOptions, assertCurrent, guard });
}
export function listPendingOperatorApprovals(params: Input<"operatorApprovals.pending"> = {}) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return execute("operatorApprovals.pending", input, { databaseOptions, assertCurrent, guard });
}
export function resolveOperatorApproval(
  params: Input<"operatorApprovals.resolve"> & {
    /** Non-throwing observer of this operation's real native commit. */
    onCommitted?: (resolutionKey: string) => void;
  },
) {
  const { databaseOptions, assertCurrent, guard, onCommitted, ...input } = params;
  return execute(
    "operatorApprovals.resolve",
    input,
    { databaseOptions, assertCurrent, guard },
    onCommitted,
  );
}
export function forceDenyOperatorApproval(params: Input<"operatorApprovals.deny">) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return execute("operatorApprovals.deny", input, { databaseOptions, assertCurrent, guard });
}
export function expireDueOperatorApprovals(params: Input<"operatorApprovals.expire">) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return execute("operatorApprovals.expire", input, { databaseOptions, assertCurrent, guard });
}
export function consumeOperatorApprovalAllowOnce(params: Input<"operatorApprovals.consume">) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return execute("operatorApprovals.consume", input, { databaseOptions, assertCurrent, guard });
}

export async function listTerminalOperatorApprovals(
  params: ListTerminalOperatorApprovalsInput & Options = {},
): Promise<ListTerminalOperatorApprovalsResult> {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  if (input.cursor !== undefined) {
    decodeOperatorApprovalHistoryCursor(input.cursor);
  }
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  const captured = structuredClone(input);
  const assertOperationCurrent = () => {
    context.admission.assertCurrent();
    guard?.assertCurrent();
    assertCurrent?.();
  };
  // Preserve creating/writable admission, then use the existing read-only owner.
  return runApprovalStoreOperation(
    context,
    captured,
    async (_scope, preparation) => {
      preparation.assertCurrent();
      assertOperationCurrent();
      preparation.release();
      const result = await executeExistingOpenClawStateRead(
        { env: context.environment, path: context.admission.databasePath },
        { type: "operatorApprovals.history", input: captured },
      );
      assertOperationCurrent();
      if (result?.ok && result.type === "operatorApprovals.history") {
        return result.history;
      }
      throw new Error("Operator approval history database became unavailable");
    },
    undefined,
    assertOperationCurrent,
  );
}
