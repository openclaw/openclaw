// Loads, updates, restores, and initializes exec approval policy state.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../agents/agent-lifecycle-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  requireOpenClawStateDatabaseIdentity,
} from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { prepareOpenClawStateDirectReader } from "../state/openclaw-state-db-read-connection.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  resolveDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
} from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { ExecAuthorizationWorkerOperations } from "./exec-approvals-authorization.worker-contract.js";
import {
  createFailClosedExecApprovalsFallback,
  parsePersistedExecApprovals,
  resolveExecApprovalsDisplayPath,
} from "./exec-approvals-config.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import type {
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
  ExecAsk,
  ExecSecurity,
} from "./exec-approvals-core.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "./exec-approvals-migration-gate.js";
import type { ExecApprovalsUpdate as ExecApprovalsMutation } from "./exec-approvals-mutation.kernel.js";
import { maxAsk, minSecurity } from "./exec-approvals-policy.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import {
  snapshotFromExecApprovalsDatabase,
  warnFailClosed,
  assertExecApprovalsMutationAllowed,
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import { hasSqliteWorkerOutcomeUnknown } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

class ExecApprovalsStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Exec approvals SQLite state is unavailable: ${String(cause)}`, { cause });
    this.name = "ExecApprovalsStoreUnavailableError";
  }
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  try {
    assertNoPendingLegacyExecApprovals();
    return snapshotFromExecApprovalsDatabase(openOpenClawStateDatabase().db);
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    // A caller-selected state owner must fail closed instead of reading another database.
    throw new ExecApprovalsStoreUnavailableError(error);
  }
}

export async function readExecApprovalsSnapshotAsync(
  context = captureOpenClawStateWorkerContext(),
): Promise<ExecApprovalsSnapshot> {
  try {
    assertNoPendingLegacyExecApprovals({ env: context.environment });
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "exec-approvals.read" },
      { context, current: true },
    );
    context.admission.assertCurrent();
    if (reply && (!reply.ok || reply.type !== "exec-approvals.read")) {
      throw new Error("Unexpected exec approvals read result");
    }
    return snapshotFromExecApprovalsRow({
      path: resolveExecApprovalsDisplayPath(context.environment),
      row: reply?.row,
      onMalformed: () =>
        warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
    });
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    throw new ExecApprovalsStoreUnavailableError(error);
  }
}

export function loadExecApprovals(): ExecApprovalsFile {
  try {
    return readExecApprovalsSnapshot().file;
  } catch (error) {
    if (!(error instanceof ExecApprovalsStoreUnavailableError)) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return createFailClosedExecApprovalsFallback();
  }
}

/** Loads exec approvals without creating or migrating shared state. */
export function loadExecApprovalsReadOnly(): ExecApprovalsFile {
  try {
    assertNoPendingLegacyExecApprovals();
    const displayPath = resolveExecApprovalsDisplayPath();
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
        snapshotFromExecApprovalsDatabase(db, displayPath),
      ) ?? snapshotFromExecApprovalsRow({ path: displayPath })
    ).file;
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return createFailClosedExecApprovalsFallback();
  }
}

/** Admit the final reader during preparation; every guard reads the current row directly. */
export function prepareExecApprovalsCurrentRead(
  context: OpenClawStateWorkerContext,
): () => ExecApprovalsFile {
  context.admission.assertCurrent();
  assertNoPendingLegacyExecApprovals({ env: context.environment });
  const reader = prepareOpenClawStateDirectReader(context);
  const displayPath = resolveExecApprovalsDisplayPath(context.environment);
  return () => {
    context.admission.assertCurrent();
    assertNoPendingLegacyExecApprovals({ env: context.environment });
    return reader.read(({ db }) => snapshotFromExecApprovalsDatabase(db, displayPath).file);
  };
}

/** Capture the policy owner before yielding; reads never initialize or migrate state. */
export async function loadExecApprovalsReadOnlyAsync(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<ExecApprovalsFile> {
  return (await readExecApprovalsPolicyReadOnlyAsync(options)).file;
}

/** The revision includes the physical policy owner; unavailable reads cannot seed caches. */
export async function readExecApprovalsPolicyReadOnlyAsync(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<{ file: ExecApprovalsFile; revision?: string }> {
  const stateDbPath = resolveDatabasePath(options);
  const owner = {
    path: stateDbPath,
    env: { OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(stateDbPath) },
  };
  try {
    assertNoPendingLegacyExecApprovals({ env: owner.env });
    const reply = await executeExistingOpenClawStateRead(owner, { type: "exec-approvals.read" });
    if (reply && (!reply.ok || reply.type !== "exec-approvals.read")) {
      throw new Error("Unexpected exec approvals read result");
    }
    const snapshot = snapshotFromExecApprovalsRow({
      path: resolveExecApprovalsDisplayPath(owner.env),
      row: reply?.row,
      onMalformed: () =>
        warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
    });
    return { file: snapshot.file, revision: JSON.stringify([stateDbPath, snapshot.hash]) };
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return { file: createFailClosedExecApprovalsFallback() };
  }
}

type CronExecHostPolicyUse = {
  ready: boolean;
  retired: boolean;
  pending: number;
  initiating: boolean;
  accepts: (file: ExecApprovalsFile) => boolean;
};
const cronPolicyUses = resolveGlobalSingleton(
  Symbol.for("openclaw.execApprovalsCronPolicyUses"),
  () => new Map<string, Set<CronExecHostPolicyUse>>(),
);

const pendingPolicyPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.execApprovalsPendingPolicyPublications"),
  () => new Map<string, Set<ExecApprovalsFile>>(),
);

function retainCronPolicyPublication(key: string, file: ExecApprovalsFile): () => void {
  const affected = [...(cronPolicyUses.get(key) ?? [])].filter((use) => !use.accepts(file));
  if (affected.some((use) => use.initiating)) {
    throw new Error(
      "Exec policy change refused while cron native launch acknowledgement is pending; retry after command startup settles.",
    );
  }
  const pending = pendingPolicyPublications.get(key) ?? new Set<ExecApprovalsFile>();
  pendingPolicyPublications.set(key, pending);
  pending.add(file);
  for (const use of affected) {
    // Rollback and an unknown write outcome cannot revive an already revoked use.
    use.retired = true;
  }
  let unregister = () => {};
  const release = () => {
    pending.delete(file);
    if (!pending.size && pendingPolicyPublications.get(key) === pending) {
      pendingPolicyPublications.delete(key);
    }
    unregister();
  };
  unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      if (!identity || identity.key === key) {
        release();
      }
    },
  });
  return release;
}

/** Live uses retain eligibility, not policy snapshots; native writers publish before returning. */
export async function prepareCronExecHostPolicyUse(
  context: OpenClawStateWorkerContext,
  params: {
    agentId: string;
    security: ExecSecurity;
    ask: ExecAsk;
    bypassHostApprovalFloors?: boolean;
  },
): Promise<{
  assertCurrent: () => void;
  release: () => void;
  initiate: <T>(effect: () => T, settlement?: Promise<unknown>) => T;
}> {
  context.admission.assertCurrent();
  const requested = { ...params };
  const key = context.admission.identity.key;
  const uses = cronPolicyUses.get(key) ?? new Set<CronExecHostPolicyUse>();
  cronPolicyUses.set(key, uses);
  const use: CronExecHostPolicyUse = {
    ready: false,
    retired: false,
    pending: 0,
    initiating: false,
    accepts(file) {
      const current = resolveExecApprovalsFromFileInternal({
        file,
        agentId: requested.agentId,
        overrides: requested,
      }).agent;
      const security = requested.bypassHostApprovalFloors
        ? requested.security
        : minSecurity(requested.security, current.security);
      const ask = requested.bypassHostApprovalFloors
        ? requested.ask
        : maxAsk(requested.ask, current.ask);
      return security !== "deny" && ask !== "always";
    },
  };
  use.retired = [...(pendingPolicyPublications.get(key) ?? [])].some((file) => !use.accepts(file));
  uses.add(use);
  let unregister = () => {};
  const release = () => {
    use.retired = true;
    if (use.initiating) {
      return;
    }
    uses.delete(use);
    if (uses.size === 0 && cronPolicyUses.get(key) === uses) {
      cronPolicyUses.delete(key);
    }
    unregister();
  };
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (!use.ready || use.retired || use.pending > 0) {
      throw new Error("Exec approval policy changed before cron execution");
    }
  };
  try {
    unregister = registerOpenClawStateDatabaseAsyncResource({
      async close(identity) {
        if (!identity || identity.key === key) {
          use.initiating = false;
          release();
        }
      },
    });
    assertNoPendingLegacyExecApprovals({ env: context.environment });
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "exec-approvals.read" },
      { context, current: true },
    );
    if (!reply?.ok || reply.type !== "exec-approvals.read") {
      throw new Error("Exec approval policy snapshot is unavailable");
    }
    const file = snapshotFromExecApprovalsRow({
      path: resolveExecApprovalsDisplayPath(context.environment),
      row: reply.row,
    }).file;
    // A commit during this read permanently retires the old use, even after policy restoration.
    use.retired ||= !use.accepts(file);
    use.ready = true;
    assertCurrent();
    return {
      assertCurrent,
      release,
      initiate(effect, settlement) {
        assertCurrent();
        use.retired = true;
        use.initiating = true;
        if (settlement) {
          void settlement.then(
            () => {
              use.initiating = false;
              release();
            },
            () => {
              // Unknown native initiation retains the mutation fence until source retirement.
            },
          );
        }
        try {
          return effect();
        } finally {
          if (!settlement) {
            use.initiating = false;
          }
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

function stageCronExecHostPolicyPublication(db: DatabaseSync, file: ExecApprovalsFile): void {
  if (cronPolicyUses.size === 0) {
    return;
  }
  const key = requireOpenClawStateDatabaseIdentity({ db }).key;
  const affected = [...(cronPolicyUses.get(key) ?? [])].filter((use) => !use.accepts(file));
  if (affected.length === 0) {
    return;
  }
  if (affected.some((use) => use.initiating)) {
    throw new Error(
      "Exec policy change refused while cron native launch acknowledgement is pending; retry after command startup settles.",
    );
  }
  const retire = () => {
    for (const use of affected) {
      use.pending--;
      use.retired = true;
    }
  };
  if (
    !stageSqliteTransactionState(db, {
      stage() {
        for (const use of affected) {
          use.pending++;
        }
      },
      commit: retire,
      // A failed/uncertain write cannot revive this use; a fresh read may prepare another.
      rollback: retire,
    })
  ) {
    throw new Error("Exec approval policy publication requires its native transaction owner");
  }
}

type NativeExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
  assertCurrent?: () => void;
};

/** Doctor retains its synchronous native migration transaction. Runtime edits use the writer. */
export function updateExecApprovalsForMaintenance(
  params: NativeExecApprovalsUpdate,
  options: OpenClawStateDatabaseOptions = {},
): ExecApprovalsSnapshot | null {
  assertNoPendingLegacyExecApprovals();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent?.();
      const current = snapshotFromExecApprovalsRow({
        path: resolveExecApprovalsDisplayPath(),
        row: readExecApprovalsConfigRow(db),
        onMalformed: () =>
          warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
      });
      if (params.baseHash !== undefined && current.hash !== params.baseHash) {
        return null;
      }
      const next = params.update(structuredClone(current.file));
      if (next === null) {
        return current;
      }
      assertExecApprovalsMutationAllowed({
        db,
        current: current.file,
        next,
      });
      const raw = serializeExecApprovals(next);
      if (current.exists && current.raw === raw) {
        return current;
      }
      const persistedRaw = writeExecApprovalsConfigRow({ db, file: next });
      const snapshot = snapshotFromExecApprovalsRow({
        path: current.path,
        row: { raw_json: persistedRaw },
      });
      stageCronExecHostPolicyPublication(db, snapshot.file);
      params.assertCurrent?.();
      return snapshot;
    },
    options,
    { operationLabel: "exec-approvals.update" },
  );
}

type PolicyMutationOperations = Omit<
  ExecAuthorizationWorkerOperations,
  "execApprovals.commitAuthorizations"
>;

async function mutateExecPolicy<Key extends keyof PolicyMutationOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: PolicyMutationOperations[Key]["input"] },
  assertCurrent?: () => void,
  assertPreparationCurrent = assertCurrent,
): Promise<PolicyMutationOperations[Key]["output"]> {
  assertNoPendingLegacyExecApprovals({ env: context.environment });
  const captured = structuredClone(command);
  // A later authorization cannot join a batch from before this policy mutation.
  pendingAuthorizationBatches.length = 0;
  let publicationSettled: Promise<void> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(captured), {
      assertCurrent: assertPreparationCurrent,
      createAdmission(operation) {
        let transaction = false;
        let staged: unknown;
        let release: (() => void) | undefined;
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          context.admission.assertCurrent();
          assertCurrent?.();
          if (request.stage === "transaction" && !transaction) {
            transaction = true;
          } else if (request.stage === "commit" && transaction) {
            transaction = false;
            if (request.facts !== undefined) {
              if (!isRecord(request.facts) || request.facts.kind !== "exec-policy-publication") {
                throw new Error("Exec policy mutation omitted its publication");
              }
              const parsed = parsePersistedExecApprovals(JSON.stringify(request.facts.file));
              if (!parsed.ok || release) {
                throw new Error("Exec policy mutation returned an invalid publication");
              }
              staged = request.facts;
              release = retainCronPolicyPublication(context.admission.identity.key, parsed.value);
            }
          } else {
            throw new Error("Exec policy mutation requested authority out of order");
          }
          if (!grant()) {
            throw new Error("Exec policy mutation lost admission");
          }
        });
        publicationSettled = operation.settled.then((settlement) => {
          const receipt = admission.committed?.facts;
          if (receipt !== undefined && !isDeepStrictEqual(receipt, staged)) {
            throw new Error("Exec policy receipt changed its prepared publication");
          }
          // Unknown native work keeps new uses fenced until physical source retirement.
          if (settlement.kind !== "unknown" || receipt !== undefined) {
            release?.();
          }
        });
        void publicationSettled.catch(() => undefined);
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    });
  } finally {
    await publicationSettled;
  }
}

export function updateExecApprovals(
  params: {
    baseHash?: string;
    update: ExecApprovalsMutation;
    assertCurrent?: () => void;
    assertPreparationCurrent?: () => void;
  },
  context = captureOpenClawStateWorkerContext(),
): Promise<ExecApprovalsSnapshot | null> {
  return mutateExecPolicy(
    context,
    {
      type: "execApprovals.update",
      input: { baseHash: params.baseHash, update: params.update },
    },
    params.assertCurrent,
    params.assertPreparationCurrent,
  );
}

type CommittedExecAuthorization = {
  snapshot: ExecApprovalsSnapshot;
  readCurrent: () => ExecApprovalsFile;
};
type PendingAuthorization = {
  input: ExecAuthorizationCommitInput;
  context: OpenClawStateWorkerContext;
  signal: AbortSignal | undefined;
  resolve: (result: CommittedExecAuthorization) => void;
  reject: (error: unknown) => void;
  assertCurrent?: () => void;
};
const pendingAuthorizationBatches: [PendingAuthorization, ...PendingAuthorization[]][] = [];

/** Coalesce this turn's authorizations; the shared-state actor owns ordered settlement. */
export function commitExecAuthorizations(
  input: ExecAuthorizationCommitInput,
  assertCurrent?: () => void,
  context = captureOpenClawStateWorkerContext(),
): Promise<CommittedExecAuthorization> {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  return maintenance
    ? maintenance.run(() => enqueueExecAuthorization(input, assertCurrent, context))
    : enqueueExecAuthorization(input, assertCurrent, context);
}

function enqueueExecAuthorization(
  input: ExecAuthorizationCommitInput,
  assertCurrent?: () => void,
  context = captureOpenClawStateWorkerContext(),
): Promise<CommittedExecAuthorization> {
  assertNoPendingLegacyExecApprovals({ env: context.environment });
  const completion = createDeferredCore<CommittedExecAuthorization>();
  const request: PendingAuthorization = {
    input: structuredClone(input),
    context,
    signal: getAsyncWorkSignal(),
    resolve: completion.resolve,
    reject: completion.reject,
    assertCurrent,
  };
  let batch = pendingAuthorizationBatches.at(-1);
  if (batch) {
    const owner = batch[0].context;
    // Independent request lifetimes cannot share an all-or-nothing transaction.
    if (
      batch[0].assertCurrent !== assertCurrent ||
      batch[0].signal !== request.signal ||
      batch.length >= 64 ||
      owner.admission.identity.key !== context.admission.identity.key ||
      owner.maintenanceScope !== context.maintenanceScope ||
      owner.existingSchemaPath !== context.existingSchemaPath ||
      owner.environment.OPENCLAW_SUPERVISOR_MODE !== context.environment.OPENCLAW_SUPERVISOR_MODE
    ) {
      batch = undefined;
    }
  }
  if (!batch) {
    batch = [request];
    pendingAuthorizationBatches.push(batch);
    const pending = batch;
    const assertBatchCurrent = () => {
      for (const item of pending) {
        item.context.admission.assertCurrent();
        item.assertCurrent?.();
      }
    };
    queueMicrotask(() => {
      const index = pendingAuthorizationBatches.indexOf(pending);
      if (index >= 0) {
        pendingAuthorizationBatches.splice(index, 1);
      }
    });
    void runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const results = await scope.execute({
          type: "execApprovals.commitAuthorizations",
          input: { items: pending.map((item) => item.input) },
        });
        return pending.map((item, index) => {
          const result = results[index];
          try {
            if (!result?.ok) {
              throw new Error(result?.message ?? "Missing exec authorization result");
            }
            const readCurrent = prepareExecApprovalsCurrentRead(item.context);
            return () =>
              item.resolve({
                snapshot: result.snapshot,
                readCurrent: () => {
                  item.assertCurrent?.();
                  return readCurrent();
                },
              });
          } catch (error) {
            return () => item.reject(error);
          }
        });
      },
      {
        assertCurrent: assertBatchCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertBatchCurrent, [
          context.admission.databasePath,
        ]),
      },
    ).then(
      (settlements) => settlements.forEach((settle) => settle()),
      (error: unknown) => pending.forEach((item) => item.reject(error)),
    );
  } else {
    batch.push(request);
  }
  return completion.promise;
}

/** Remove only the captured deletion operation's policies; restore them after a definite failure. */
export async function withAgentExecApprovalsRemoved<T>(
  authority: { agentId: string; operationId: string },
  commit: () => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  let context: OpenClawStateWorkerContext;
  try {
    context = captureOpenClawStateWorkerContext({
      ...options,
      path: options.database?.path ?? options.path,
    });
  } catch (error) {
    throw new ExecApprovalsStoreUnavailableError(error);
  }
  const input = {
    agentId: normalizeAgentId(authority.agentId),
    operationId: authority.operationId,
  };
  let removed;
  try {
    removed = await mutateExecPolicy(context, { type: "execApprovals.removeAgent", input });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw new AgentDeletionCommitUncertainError(error);
    }
    throw error;
  }
  try {
    context.admission.assertCurrent();
    return await commit();
  } catch (error) {
    if (error instanceof AgentDeletionCommitUncertainError) {
      throw error;
    }
    if (removed.entries.length > 0) {
      try {
        await mutateExecPolicy(context, { type: "execApprovals.restoreAgent", input: removed });
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `Failed to roll back exec approvals deletion for agent ${input.agentId}.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export function restoreExecApprovalsSnapshotLocked(
  snapshot: ExecApprovalsSnapshot,
  baseHash: string,
  context = captureOpenClawStateWorkerContext(),
  assertCurrent?: () => void,
): Promise<boolean> {
  return mutateExecPolicy(
    context,
    {
      type: "execApprovals.restoreSnapshot",
      input: { snapshot, baseHash },
    },
    assertCurrent,
  );
}

export function ensureExecApprovalsSnapshot(
  assertCurrent?: () => void,
  assertPreparationCurrent = assertCurrent,
): Promise<ExecApprovalsSnapshot> {
  return mutateExecPolicy(
    captureOpenClawStateWorkerContext(),
    {
      type: "execApprovals.ensureSnapshot",
      input: undefined,
    },
    assertCurrent,
    assertPreparationCurrent,
  );
}
