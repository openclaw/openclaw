import { AsyncLocalStorage } from "node:async_hooks";
import { serialize } from "node:v8";
import { expectDefined } from "@openclaw/normalization-core";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { execApprovalsPublication } from "../infra/exec-approvals-publication.js";
import type { SqliteWorkerInputPreparation } from "../infra/sqlite-worker-broker.types.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../infra/sqlite-worker-operation-settlement.js";
// Runtime approval operations retain the shared-state owner through worker settlement.
import {
  createSqliteWorkerWriteAdmission,
  reserveSqliteWorkerInputPreparation,
} from "../infra/sqlite-worker-store.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "../state/openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperationOptions } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { batchStateDomainPublications } from "../state/state-domain-publication.js";
import type {
  CronStandingGrantLookupInput,
  ConsumeCronStandingGrantResult,
} from "./operator-approval-standing-grants.types.js";
import {
  operatorApprovalPublication,
  operatorStandingGrantPublication,
} from "./operator-approval-store.publication.js";
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
  { databaseOptions, assertCurrent, guard, ...input }: Input<Key>,
  options?: {
    onCommitted?: (resolutionKey: string) => void;
    changesExecPolicy?: boolean;
    context?: OpenClawStateWorkerContext;
    read?: {
      command: Extract<OpenClawStateReadCommand, { type: `operatorApprovals.${string}` }>;
      project: (
        result: OpenClawStateReadResult,
      ) => OperatorApprovalWorkerOperations[Key]["output"] | undefined;
    };
  },
): Promise<OperatorApprovalWorkerOperations[Key]["output"]> {
  const context =
    options?.context ??
    captureOpenClawStateWorkerContext({
      ...databaseOptions,
      path: databaseOptions?.database?.path ?? databaseOptions?.path,
    });
  const captured = structuredClone(input);
  // Worker settlement owns its work; live guards retain the caller's approval scope.
  const assertCallerCurrent = AsyncLocalStorage.bind(() => {
    guard?.assertCurrent();
    assertCurrent?.();
  });
  if (guard?.family === "native-compatibility") {
    warnPluginSdkDeprecation({
      family: "native-approval-callback",
      method: "GatewayRequestHandlerOptions.sessionMutationCommitGuard (approval persistence)",
      replacement: "api.runtime.gateway.request approval methods with host-bound authority",
    });
  }
  let admission: SqliteWorkerOperationAdmission | undefined;
  const createAdmission: SqliteWorkerAdmissionFactory = (operation) => {
    let commitAdmitted = false;
    const retained = createSqliteWorkerWriteAdmission(
      (request) => {
        context.admission.assertCurrent();
        if (request.stage === "commit") {
          assertCallerCurrent();
          commitAdmitted = true;
        }
      },
      [context.admission.databasePath],
    )(operation);
    admission = retained.admission;
    const owner = {
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    };
    const approvals = operatorApprovalPublication.begin(owner);
    const grants = operatorStandingGrantPublication.begin(owner);
    const exec = execApprovalsPublication.begin({
      ...owner,
      // Approval bookkeeping cannot revoke exec authority; durable MCP grants can.
      publishPending: options?.changesExecPolicy === true,
    });
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      batchStateDomainPublications(() => {
        approvals.committed(isRecord(facts) ? facts.approvalFacts : undefined);
        grants.committed(isRecord(facts) ? facts.standingGrantFacts : undefined);
        exec.committed(isRecord(facts) ? facts.execFacts : undefined);
      });
    });
    observeSqliteWorkerAdmissionFinish(admission, () => {
      const confirmed = admission?.settlement?.kind === "completed";
      const rolledBack = confirmed && !admission?.committed && !commitAdmitted;
      approvals.finish(confirmed, rolledBack);
      grants.finish(confirmed, rolledBack);
      exec.finish(confirmed, rolledBack);
    });
    return retained;
  };
  return runApprovalStoreOperation(
    context,
    captured,
    async (scope, preparation) => {
      try {
        if (options?.read) {
          assertCallerCurrent();
          const result = await readApprovalStoreCommand(context, options.read.command);
          context.admission.assertCurrent();
          assertCallerCurrent();
          const value = options.read.project(result);
          if (value !== undefined) {
            return value;
          }
        }
        return await preparation.handoff(() => scope.execute({ type, input: captured }));
      } finally {
        // Broker settlement retains the native receipt even when the command reply is lost.
        const facts = admission?.committed?.facts;
        if (
          options?.onCommitted &&
          isRecord(facts) &&
          facts.type === "operatorApprovals.resolve" &&
          typeof facts.resolutionKey === "string"
        ) {
          options.onCommitted(facts.resolutionKey);
        }
      }
    },
    {
      createAdmission,
    },
  );
}

export function recoverOperatorApprovalsOnStartup(
  params: Input<"operatorApprovals.recoverStartup">,
) {
  return execute("operatorApprovals.recoverStartup", params);
}
export function insertOperatorApproval(params: Input<"operatorApprovals.insert">) {
  return execute("operatorApprovals.insert", params);
}
export function getOperatorApprovalDetailed(params: Input<"operatorApprovals.get">) {
  return execute("operatorApprovals.get", params);
}
export function listPendingOperatorApprovals(params: Input<"operatorApprovals.pending"> = {}) {
  const {
    databaseOptions: _databaseOptions,
    assertCurrent: _assertCurrent,
    guard: _guard,
    ...input
  } = params;
  return execute("operatorApprovals.pending", params, {
    read: {
      command: { type: "operatorApprovals.pending", input },
      // Repairs retain this operation's FIFO position and publish normal committed receipts.
      project: (result) =>
        result.type === "operatorApprovals.pending" && !result.pending.corrupt.length
          ? result.pending.records
          : undefined,
    },
  });
}
export function prepareOperatorApprovalReplay(
  params: Input<"operatorApprovals.prepareReplay"> = {},
) {
  const {
    databaseOptions: _databaseOptions,
    assertCurrent: _assertCurrent,
    guard: _guard,
    nowMs = Date.now(),
    ...selection
  } = params;
  return execute(
    "operatorApprovals.prepareReplay",
    { ...params, nowMs },
    {
      read: {
        command: { type: "operatorApprovals.prepareReplay", input: { ...selection, nowMs } },
        // Due expirations and corrupt rows retain this admission through writer settlement.
        project: (result) =>
          result.type === "operatorApprovals.prepareReplay" &&
          result.replay.outcome === "pending" &&
          !result.replay.corrupt.length
            ? { outcome: "pending", records: result.replay.records }
            : undefined,
      },
    },
  );
}
export function resolveOperatorApproval(
  params: Input<"operatorApprovals.resolve"> & {
    /** Non-throwing observer of this operation's real native commit. */
    onCommitted?: (resolutionKey: string) => void;
  },
) {
  const { onCommitted, ...input } = params;
  return execute("operatorApprovals.resolve", input, {
    onCommitted,
    changesExecPolicy: input.decision === "allow-always" && input.mcpToolGrant !== undefined,
  });
}
export function forceDenyOperatorApproval(params: Input<"operatorApprovals.deny">) {
  return execute("operatorApprovals.deny", params);
}
export function consumeOperatorApprovalAllowOnce(params: Input<"operatorApprovals.consume">) {
  return execute("operatorApprovals.consume", params);
}

async function readApprovalStoreCommand(
  context: OpenClawStateWorkerContext,
  command: Extract<OpenClawStateReadCommand, { type: `operatorApprovals.${string}` }>,
): Promise<OpenClawStateReadResult> {
  const result = await executeExistingOpenClawStateRead(
    { env: context.environment, path: context.admission.databasePath },
    command,
  );
  if (!result?.ok || result.type !== command.type) {
    throw new Error("Operator approval database became unavailable");
  }
  return result;
}

async function readApprovalStore<T>(
  command: Extract<OpenClawStateReadCommand, { type: `operatorApprovals.${string}` }>,
  { databaseOptions, assertCurrent, guard }: Options,
  project: (result: OpenClawStateReadResult) => T | undefined,
): Promise<T> {
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  const captured = structuredClone(command);
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
      const result = await readApprovalStoreCommand(context, captured);
      assertOperationCurrent();
      const value = project(result);
      if (value !== undefined) {
        return value;
      }
      throw new Error("Operator approval database became unavailable");
    },
    undefined,
    assertOperationCurrent,
  );
}

export async function listTerminalOperatorApprovals(
  params: ListTerminalOperatorApprovalsInput & Options = {},
): Promise<ListTerminalOperatorApprovalsResult> {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  if (input.cursor !== undefined) {
    decodeOperatorApprovalHistoryCursor(input.cursor);
  }
  return readApprovalStore(
    { type: "operatorApprovals.history", input },
    { databaseOptions, assertCurrent, guard },
    (result) => (result.type === "operatorApprovals.history" ? result.history : undefined),
  );
}

export function listCronStandingGrants(params: { limit?: number } & Options = {}) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return readApprovalStore(
    { type: "operatorApprovals.listCronGrants", input },
    { databaseOptions, assertCurrent, guard },
    (result) => (result.type === "operatorApprovals.listCronGrants" ? result.grants : undefined),
  );
}

export function revokeCronStandingGrant(params: Input<"operatorApprovals.revokeCronGrant">) {
  return execute("operatorApprovals.revokeCronGrant", params);
}

export function validateCronStandingGrant(params: CronStandingGrantLookupInput & Options) {
  const { databaseOptions, assertCurrent, guard, ...input } = params;
  return readApprovalStore(
    { type: "operatorApprovals.validateCronGrant", input },
    { databaseOptions, assertCurrent, guard },
    (result) => (result.type === "operatorApprovals.validateCronGrant" ? result.result : undefined),
  );
}

export function consumeCronStandingGrant(
  context: OpenClawStateWorkerContext,
  input: CronStandingGrantLookupInput & { recordUse: boolean },
  assertCurrent: () => void,
): Promise<ConsumeCronStandingGrantResult> {
  return execute("operatorApprovals.consumeCronGrant", { ...input, assertCurrent }, { context });
}

export function readPlacementStandingGrant(
  input: import("./operator-approval-placement-grants.read.worker.js").PlacementGrantReadInput,
  options: Options,
) {
  return readApprovalStore(
    { type: "operatorApprovals.placementGrant", input },
    options,
    (result) => (result.type === "operatorApprovals.placementGrant" ? result.rows : undefined),
  );
}
