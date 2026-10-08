// Loads, updates, restores, and initializes exec approval policy state.
import type { DatabaseSync } from "node:sqlite";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../agents/agent-lifecycle-registry.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  requireOpenClawStateDatabaseIdentity,
} from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
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
import {
  createFailClosedExecApprovalsFallback,
  generateToken,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
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
import { maxAsk, minSecurity } from "./exec-approvals-policy.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import {
  snapshotFromExecApprovalsDatabase,
  warnFailClosed,
  assertExecApprovalsMutationAllowed,
  assertExecApprovalsMutationAuthority,
  deleteExecApprovalsConfigRow,
  ExecApprovalsMutationFencedError,
  type ExecApprovalsMutationAuthority,
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";

class ExecApprovalsStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Exec approvals SQLite state is unavailable: ${String(cause)}`, { cause });
    this.name = "ExecApprovalsStoreUnavailableError";
  }
}

function readExecApprovalsSnapshotFromDatabaseReadOnly(
  options: OpenClawStateDatabaseOptions,
): ExecApprovalsSnapshot {
  assertNoPendingLegacyExecApprovals({ env: options.env });
  const displayPath = resolveExecApprovalsDisplayPath(options.env);
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => snapshotFromExecApprovalsDatabase(db, displayPath),
      options,
    ) ?? snapshotFromExecApprovalsRow({ path: displayPath, row: undefined })
  );
}

function readExecApprovalsSnapshotWithOptions(
  options: OpenClawStateDatabaseOptions = {},
): ExecApprovalsSnapshot {
  try {
    assertNoPendingLegacyExecApprovals();
    return snapshotFromExecApprovalsDatabase(openOpenClawStateDatabase(options).db);
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    // A caller-selected state owner must fail closed instead of reading another database.
    throw new ExecApprovalsStoreUnavailableError(error);
  }
}

export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  return readExecApprovalsSnapshotWithOptions();
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

function loadExecApprovalsReadOnlyWithOptions(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
): ExecApprovalsFile {
  try {
    return readExecApprovalsSnapshotFromDatabaseReadOnly(options).file;
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return createFailClosedExecApprovalsFallback();
  }
}

/** Loads exec approvals without creating or migrating shared state. */
export function loadExecApprovalsReadOnly(): ExecApprovalsFile {
  return loadExecApprovalsReadOnlyWithOptions({});
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

type ExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
  assertCurrent?: () => void;
};

export function replaceExecApprovalsSnapshot(
  target: ExecApprovalsFile,
  source: ExecApprovalsFile,
): void {
  target.version = source.version;
  if (source.socket === undefined) {
    delete target.socket;
  } else {
    target.socket = source.socket;
  }
  if (source.defaults === undefined) {
    delete target.defaults;
  } else {
    target.defaults = source.defaults;
  }
  if (source.agents === undefined) {
    delete target.agents;
  } else {
    target.agents = source.agents;
  }
}

type InternalExecApprovalsUpdate = ExecApprovalsUpdate & {
  authority?: ExecApprovalsMutationAuthority;
};

function updateExecApprovalsInTransaction(
  params: InternalExecApprovalsUpdate,
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
        authority: params.authority,
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

export function updateExecApprovalsSync(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  return updateExecApprovalsInTransaction(params);
}

export async function updateExecApprovals(
  params: ExecApprovalsUpdate,
): Promise<ExecApprovalsSnapshot | null> {
  return updateExecApprovalsInTransaction(params);
}

type CommittedExecAuthorization = {
  snapshot: ExecApprovalsSnapshot;
  readCurrent: () => ExecApprovalsFile;
};
type PendingAuthorization = {
  input: ExecAuthorizationCommitInput;
  context: OpenClawStateWorkerContext;
  resolve: (result: CommittedExecAuthorization) => void;
  reject: (error: unknown) => void;
};
const pendingAuthorizationBatches: [PendingAuthorization, ...PendingAuthorization[]][] = [];

/** Coalesce this turn's authorizations; the shared-state actor owns ordered settlement. */
export function commitExecAuthorizations(
  input: ExecAuthorizationCommitInput,
): Promise<CommittedExecAuthorization> {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  return maintenance
    ? maintenance.run(() => enqueueExecAuthorization(input))
    : enqueueExecAuthorization(input);
}

function enqueueExecAuthorization(
  input: ExecAuthorizationCommitInput,
): Promise<CommittedExecAuthorization> {
  const context = captureOpenClawStateWorkerContext();
  assertNoPendingLegacyExecApprovals({ env: context.environment });
  const completion = createDeferredCore<CommittedExecAuthorization>();
  const request: PendingAuthorization = {
    input: structuredClone(input),
    context,
    resolve: completion.resolve,
    reject: completion.reject,
  };
  let batch = pendingAuthorizationBatches.at(-1);
  if (batch) {
    const owner = batch[0].context;
    if (
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
    queueMicrotask(() => {
      pendingAuthorizationBatches.splice(pendingAuthorizationBatches.indexOf(pending), 1);
      void runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "execApprovals.commitAuthorizations",
            input: { items: pending.map((item) => item.input) },
          }),
        { assertCurrent: () => pending.forEach((item) => item.context.admission.assertCurrent()) },
      ).then(
        (results) => {
          for (const [index, item] of pending.entries()) {
            const result = results[index];
            if (!result?.ok) {
              item.reject(new Error(result?.message ?? "Missing exec authorization result"));
              continue;
            }
            item.resolve({
              snapshot: result.snapshot,
              readCurrent: () => {
                item.context.admission.assertCurrent();
                return loadExecApprovalsReadOnlyWithOptions({
                  path: item.context.admission.databasePath,
                  env: item.context.environment,
                });
              },
            });
          }
        },
        (error: unknown) => pending.forEach((item) => item.reject(error)),
      );
    });
  } else {
    batch.push(request);
  }
  return completion.promise;
}

/** Remove one deleted agent's policy aliases, restoring them if commit fails. */
export async function withAgentExecApprovalsRemoved<T>(
  agentId: string,
  commit: () => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  const key = normalizeAgentId(agentId);
  const snapshot = readExecApprovalsSnapshotWithOptions(options);
  const operationId = readAgentDeletionJournal(key, options)?.operationId;
  if (!operationId) {
    throw new ExecApprovalsMutationFencedError();
  }
  const removedPolicyEntries = Object.entries(snapshot.file.agents ?? {}).filter(([policyKey]) => {
    const normalizedPolicyKey = normalizeAgentIdStrict(policyKey);
    return normalizedPolicyKey.ok && normalizedPolicyKey.value === key;
  });
  if (removedPolicyEntries.length > 0) {
    const updated = updateExecApprovalsInTransaction(
      {
        baseHash: snapshot.hash,
        authority: { action: "remove", agentId: key, operationId },
        update: (file) => {
          const agents = { ...file.agents };
          for (const [policyKey] of removedPolicyEntries) {
            delete agents[policyKey];
          }
          return { ...file, agents };
        },
      },
      options,
    );
    if (!updated) {
      throw new Error("Exec approvals changed while deleting agent; retry deletion.");
    }
  } else {
    runOpenClawStateWriteTransaction(({ db }) => {
      assertExecApprovalsMutationAuthority(db, {
        action: "remove",
        agentId: key,
        operationId,
      });
    }, options);
  }
  try {
    return await commit();
  } catch (error) {
    if (error instanceof AgentDeletionCommitUncertainError) {
      throw error;
    }
    if (removedPolicyEntries.length > 0) {
      try {
        updateExecApprovalsInTransaction(
          {
            authority: { action: "restore", agentId: key, operationId },
            update: (file) => ({
              ...file,
              agents: { ...file.agents, ...Object.fromEntries(removedPolicyEntries) },
            }),
          },
          options,
        );
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

export async function restoreExecApprovalsSnapshotLocked(
  snapshot: ExecApprovalsSnapshot,
  baseHash: string,
): Promise<boolean> {
  assertNoPendingLegacyExecApprovals();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = snapshotFromExecApprovalsRow({
        path: resolveExecApprovalsDisplayPath(),
        row: readExecApprovalsConfigRow(db),
      });
      if (current.hash !== baseHash) {
        return false;
      }
      assertExecApprovalsMutationAllowed({ db, current: current.file, next: snapshot.file });
      let restoredRaw: string | undefined;
      if (!snapshot.exists) {
        deleteExecApprovalsConfigRow(db);
      } else {
        const raw = snapshot.raw ?? serializeExecApprovals(snapshot.file);
        restoredRaw = writeExecApprovalsConfigRow({ db, file: snapshot.file, raw });
      }
      stageCronExecHostPolicyPublication(
        db,
        snapshotFromExecApprovalsRow({
          path: current.path,
          row: restoredRaw === undefined ? undefined : { raw_json: restoredRaw },
        }).file,
      );
      return true;
    },
    {},
    { operationLabel: "exec-approvals.restore-cas" },
  );
}

function ensureExecApprovalsSocket(file: ExecApprovalsFile): ExecApprovalsFile {
  const next = normalizeExecApprovalsInternal(file);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  return {
    ...next,
    socket: {
      path: socketPath || resolveExecApprovalsSocketPath(),
      token: token || generateToken(),
    },
  };
}

export async function ensureExecApprovalsSnapshot(): Promise<ExecApprovalsSnapshot> {
  const snapshot = readExecApprovalsSnapshot();
  if (
    snapshot.file.socket?.path?.trim() &&
    snapshot.file.socket.token?.trim() &&
    snapshot.raw === serializeExecApprovals(ensureExecApprovalsSocket(snapshot.file))
  ) {
    return snapshot;
  }
  const initialized = updateExecApprovalsInTransaction({ update: ensureExecApprovalsSocket });
  if (!initialized) {
    throw new Error("Failed to initialize exec approvals");
  }
  return initialized;
}
