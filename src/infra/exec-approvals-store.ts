// Loads, updates, restores, and initializes exec approval policy state.
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../agents/agent-lifecycle-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
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
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import {
  retainCronPolicyPublication,
  stageCronExecHostPolicyPublication,
} from "./exec-approvals-cron-policy.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "./exec-approvals-migration-gate.js";
import type { ExecApprovalsUpdate as ExecApprovalsMutation } from "./exec-approvals-mutation.kernel.js";
import {
  execApprovalsPublication,
  withExecApprovalsPublication,
} from "./exec-approvals-publication.js";
import type { RemovedExecApprovalPolicies } from "./exec-approvals-retirement.worker.js";
import {
  snapshotFromExecApprovalsDatabase,
  warnFailClosed,
  assertExecApprovalsMutationAllowed,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { hasSqliteWorkerOutcomeUnknown } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

class ExecApprovalsStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Exec approvals SQLite state is unavailable: ${String(cause)}`, { cause });
    this.name = "ExecApprovalsStoreUnavailableError";
  }
}

const preparedSnapshots = resolveGlobalMap<
  string,
  { identity: string; path: string; snapshot: Promise<ExecApprovalsSnapshot> }
>(Symbol.for("openclaw.execApprovalsPreparedSnapshots"), "close-and-restart");

type CurrentExecPolicy = {
  file?: ExecApprovalsFile;
  pending: Set<string>;
};
const currentPolicies = resolveGlobalMap<string, CurrentExecPolicy>(
  Symbol.for("openclaw.execApprovalsCurrentPolicies"),
  "close-and-restart",
);

execApprovalsPublication.subscribeFacts((change) => {
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  if (typeof identity === "string") {
    let policy = currentPolicies.get(identity);
    if (!policy) {
      policy = { pending: new Set() };
      currentPolicies.set(identity, policy);
    }
    if (change.kind === "pending") {
      policy.pending.add(change.operationId);
    } else if (change.kind === "settled") {
      policy.pending.delete(change.operationId);
    } else if (change.kind === "unknown") {
      // Invalidate an in-flight seed as well as retained execution guards.
      currentPolicies.set(identity, { pending: policy.pending });
    } else {
      const fact = change.receipt.facts.get("current");
      if (fact?.kind === "postimage") {
        policy.file = fact.value.file;
      } else if (fact?.kind === "absent") {
        policy.file = snapshotFromExecApprovalsRow({ path: "" }).file;
      } else if (fact?.kind === "unknown") {
        currentPolicies.set(identity, { pending: policy.pending });
      }
    }
  }
  for (const [key, entry] of preparedSnapshots) {
    if (entry.identity === identity) {
      preparedSnapshots.delete(key);
    }
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    if (event.identity) {
      currentPolicies.delete(event.identity.key);
    } else {
      currentPolicies.clear();
    }
    for (const [key, entry] of preparedSnapshots) {
      if (entry.path === (event.identity?.canonicalPath ?? event.path)) {
        preparedSnapshots.delete(key);
      }
    }
  }
});

/** Preparation reuses policy facts; execution retains its direct current-row guard. */
async function readPreparedExecApprovals(
  context: OpenClawStateWorkerContext,
): Promise<ExecApprovalsSnapshot> {
  const options = { path: context.admission.databasePath, env: context.environment };
  const read = async () => {
    const reply = await executeExistingOpenClawStateRead(
      options,
      { type: "exec-approvals.read" },
      { context, current: true },
    );
    context.admission.assertCurrent();
    return snapshotFromReadReply(reply, () => resolveExecApprovalsDisplayPath(context.environment));
  };
  if (
    isArtifactPreservingStateRead() ||
    getOpenClawDatabaseMaintenanceScope() ||
    getActiveOpenClawStateDatabaseReadSnapshot(options)
  ) {
    return read();
  }
  const key = context.admission.coordinationKey;
  let entry = preparedSnapshots.get(key);
  if (entry && entry.identity !== context.admission.identity.key) {
    preparedSnapshots.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = {
      identity: context.admission.identity.key,
      path: context.admission.identity.canonicalPath,
      snapshot: read(),
    };
    preparedSnapshots.set(key, entry);
    if (preparedSnapshots.size > 64) {
      preparedSnapshots.delete(preparedSnapshots.keys().next().value!);
    }
  }
  try {
    const snapshot = await entry.snapshot;
    context.admission.assertCurrent();
    return structuredClone(snapshot);
  } catch (error) {
    if (preparedSnapshots.get(key) === entry) {
      preparedSnapshots.delete(key);
    }
    throw error;
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

function snapshotFromReadReply(
  reply: Awaited<ReturnType<typeof executeExistingOpenClawStateRead>>,
  displayPath: () => string,
): ExecApprovalsSnapshot {
  if (reply && (!reply.ok || reply.type !== "exec-approvals.read")) {
    throw new Error("Unexpected exec approvals read result");
  }
  return snapshotFromExecApprovalsRow({
    path: displayPath(),
    row: reply?.row,
    onMalformed: () =>
      warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
  });
}

export async function readExecApprovalsSnapshotAsync(
  context = captureOpenClawStateWorkerContext(),
): Promise<ExecApprovalsSnapshot> {
  try {
    assertNoPendingLegacyExecApprovals({ env: context.environment });
    return await readPreparedExecApprovals(context);
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

/** A committed policy view keeps the final execution guard synchronous and free of SQL. */
function retainExecApprovalsCurrentRead(context: OpenClawStateWorkerContext) {
  const key = context.admission.identity.key;
  let policy = currentPolicies.get(key);
  if (!policy) {
    policy = { pending: new Set() };
    currentPolicies.set(key, policy);
  }
  return {
    seed(file: ExecApprovalsFile) {
      // A publication owns newer facts; an invalidated read cannot restore authority.
      if (currentPolicies.get(key) === policy && !policy.file) {
        policy.file = file;
      }
    },
    read(): ExecApprovalsFile {
      context.admission.assertCurrent();
      const current = currentPolicies.get(key);
      if (!current?.file || current.pending.size) {
        throw new Error("Exec approval policy is unavailable or changing before execution");
      }
      return structuredClone(current.file);
    },
  };
}

/** Prepare node-local launch policy before invoking a synchronous plugin callback. */
export async function prepareExecApprovalsCurrentRead(
  context: OpenClawStateWorkerContext,
): Promise<() => ExecApprovalsFile> {
  const policy = retainExecApprovalsCurrentRead(context);
  policy.seed((await readExecApprovalsSnapshotAsync(context)).file);
  return policy.read;
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
    const snapshot =
      isArtifactPreservingStateRead() ||
      getOpenClawDatabaseMaintenanceScope() ||
      getActiveOpenClawStateDatabaseReadSnapshot(owner)
        ? snapshotFromReadReply(
            await executeExistingOpenClawStateRead(owner, { type: "exec-approvals.read" }),
            () => resolveExecApprovalsDisplayPath(owner.env),
          )
        : await readPreparedExecApprovals(captureOpenClawStateWorkerContext(owner));
    return { file: snapshot.file, revision: JSON.stringify([stateDbPath, snapshot.hash]) };
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return { file: createFailClosedExecApprovalsFallback() };
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
      const current = snapshotFromExecApprovalsDatabase(db);
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
  "execApprovals.commitAuthorizations" | "execApprovals.retireAgent"
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
      createAdmission: withExecApprovalsPublication((operation, onCommitAdmitted) => {
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
          if (request.stage === "commit") {
            onCommitAdmitted();
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
      }, context),
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
  policy: ReturnType<typeof retainExecApprovalsCurrentRead>;
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
  const policy = retainExecApprovalsCurrentRead(context);
  const request: PendingAuthorization = {
    input: structuredClone(input),
    context,
    signal: getAsyncWorkSignal(),
    resolve: completion.resolve,
    reject: completion.reject,
    assertCurrent,
    policy,
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
            item.policy.seed(result.snapshot.file);
            return () =>
              item.resolve({
                snapshot: result.snapshot,
                readCurrent: () => {
                  item.assertCurrent?.();
                  return item.policy.read();
                },
              });
          } catch (error) {
            return () => item.reject(error);
          }
        });
      },
      {
        assertCurrent: assertBatchCurrent,
        createAdmission: withExecApprovalsPublication(
          (operation, onCommitAdmitted) =>
            createSqliteWorkerWriteAdmission(
              (admissionRequest) => {
                assertBatchCurrent();
                if (admissionRequest.stage === "commit") {
                  onCommitAdmitted();
                }
              },
              [context.admission.databasePath],
            )(operation),
          context,
        ),
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
  agentId: string,
  commit: () => Promise<T>,
  authority: AgentDeletionWorkerAuthority,
): Promise<T> {
  const key = normalizeAgentId(agentId);
  const mutate = async (
    input: { action: "remove" } | { action: "restore"; entries: RemovedExecApprovalPolicies },
  ) => {
    pendingAuthorizationBatches.length = 0;
    const nonce = crypto.randomUUID();
    let operationId: string | undefined;
    let committed = false;
    let uncertain = false;
    let releasePublication: (() => void) | undefined;
    let publication: ReturnType<typeof execApprovalsPublication.begin> | undefined;
    try {
      return await authority.runWithWorker(
        (scope, guard) => {
          if (guard.predicate.agentId !== key) {
            throw new Error("Exec approval retirement differs from its deletion owner");
          }
          operationId = guard.predicate.operationId;
          return scope.execute({
            type: "execApprovals.retireAgent",
            input: { ...input, guard, nonce },
          });
        },
        {
          onAdmission(request, identityKey) {
            publication ??= execApprovalsPublication.begin({
              identity: identityKey,
              assertCurrent: authority.assertCurrentHost,
            });
            if (request.stage !== "commit") {
              return;
            }
            const facts = isRecord(request.facts) ? request.facts.domainFacts : undefined;
            if (
              !isRecord(facts) ||
              facts.kind !== "exec-approvals-retirement" ||
              facts.nonce !== nonce ||
              facts.agentId !== key ||
              facts.operationId !== operationId ||
              facts.action !== input.action ||
              (facts.raw !== null && typeof facts.raw !== "string") ||
              releasePublication
            ) {
              throw new Error("Exec approval retirement publication differs from its command");
            }
            if (facts.raw !== null) {
              releasePublication = retainCronPolicyPublication(
                identityKey,
                snapshotFromExecApprovalsRow({
                  path: "",
                  row: { raw_json: facts.raw },
                }).file,
              );
            }
          },
          onCommitted(facts) {
            if (
              !isRecord(facts) ||
              facts.kind !== "exec-approvals-retirement" ||
              facts.nonce !== nonce ||
              facts.action !== input.action
            ) {
              throw new Error("Exec approval retirement receipt differs from its command");
            }
            committed = true;
            publication?.committed(facts.execFacts);
          },
        },
      );
    } catch (error) {
      uncertain = hasSqliteWorkerOutcomeUnknown(error);
      if (committed || uncertain) {
        // Without a settled reply the removed aliases cannot safely be restored or forgotten.
        throw new AgentDeletionAuthorityRollbackError(
          [error],
          `Exec approvals retirement outcome is uncertain for agent ${key}.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      publication?.finish(committed && !uncertain);
      if (!uncertain) {
        releasePublication?.();
      }
    }
  };
  const removedPolicyEntries = await mutate({ action: "remove" });
  try {
    authority.assertCurrentHost();
    return await commit();
  } catch (error) {
    if (error instanceof AgentDeletionCommitUncertainError) {
      throw error;
    }
    if (removedPolicyEntries.length > 0) {
      try {
        await mutate({ action: "restore", entries: removedPolicyEntries });
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `Failed to roll back exec approvals deletion for agent ${key}.`,
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
