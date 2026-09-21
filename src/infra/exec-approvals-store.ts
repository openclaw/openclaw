// Loads, updates, restores, and initializes exec approval policy state.
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../agents/agent-lifecycle-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { formatErrorMessage } from "./errors.js";
import {
  createFailClosedExecApprovalsFallback,
  generateToken,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
  resetExecApprovalsMigrationGateForTest,
} from "./exec-approvals-migration-gate.js";
import {
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

const log = createSubsystemLogger("infra/exec-approvals");
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt: number | undefined;

class ExecApprovalsStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Exec approvals SQLite state is unavailable: ${String(cause)}`, { cause });
    this.name = "ExecApprovalsStoreUnavailableError";
  }
}

function warnFailClosed(message: string, error?: unknown): void {
  const now = Date.now();
  if (lastWarnAt !== undefined && now - lastWarnAt < WARN_INTERVAL_MS) {
    return;
  }
  lastWarnAt = now;
  if (error === undefined) {
    log.warn(message);
  } else {
    log.warn(message, { error: formatErrorMessage(error) });
  }
}

export function snapshotFromExecApprovalsDatabase(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
  displayPath = resolveExecApprovalsDisplayPath(),
): ExecApprovalsSnapshot {
  return snapshotFromExecApprovalsRow({
    path: displayPath,
    row: readExecApprovalsConfigRow(db),
    onMalformed: () =>
      warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
  });
}

function readExecApprovalsSnapshotFromDatabase(
  options: OpenClawStateDatabaseOptions = {},
): ExecApprovalsSnapshot {
  assertNoPendingLegacyExecApprovals();
  return snapshotFromExecApprovalsDatabase(openOpenClawStateDatabase(options).db);
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
    return readExecApprovalsSnapshotFromDatabase(options);
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
    return snapshotFromExecApprovalsRow({
      path: resolveExecApprovalsDisplayPath(owner.env),
      row: reply?.row,
      onMalformed: () =>
        warnFailClosed("exec approvals SQLite row is malformed; denying host execution"),
    }).file;
  } catch (error) {
    if (error instanceof ExecApprovalsMigrationRequiredError) {
      throw error;
    }
    warnFailClosed("exec approvals SQLite state is unavailable; denying host execution", error);
    return createFailClosedExecApprovalsFallback();
  }
}

export async function loadExecApprovalsAsync(): Promise<ExecApprovalsFile> {
  return loadExecApprovals();
}

type ExecApprovalsUpdate = {
  baseHash?: string;
  update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
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
      writeExecApprovalsConfigRow({ db, file: next, raw });
      return snapshotFromExecApprovalsRow({
        path: current.path,
        row: { raw_json: raw },
      });
    },
    options,
    { operationLabel: "exec-approvals.update" },
  );
}

export function updateExecApprovalsSync(params: ExecApprovalsUpdate): ExecApprovalsSnapshot | null {
  return updateExecApprovalsInTransaction(params);
}

export function saveExecApprovals(file: ExecApprovalsFile): void {
  updateExecApprovalsSync({ update: () => file });
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
      owner.coordinatorRuntime.directory !== context.coordinatorRuntime.directory ||
      owner.coordinatorRuntime.keepAlive !== context.coordinatorRuntime.keepAlive ||
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

function restoreExecApprovalsSnapshotInTransaction(snapshot: ExecApprovalsSnapshot): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = snapshotFromExecApprovalsRow({
        path: resolveExecApprovalsDisplayPath(),
        row: readExecApprovalsConfigRow(db),
      });
      assertExecApprovalsMutationAllowed({ db, current: current.file, next: snapshot.file });
      if (!snapshot.exists) {
        deleteExecApprovalsConfigRow(db);
        return;
      }
      const raw = snapshot.raw ?? serializeExecApprovals(snapshot.file);
      writeExecApprovalsConfigRow({ db, file: snapshot.file, raw });
    },
    {},
    { operationLabel: "exec-approvals.restore" },
  );
}

export function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void {
  assertNoPendingLegacyExecApprovals();
  restoreExecApprovalsSnapshotInTransaction(snapshot);
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
      if (!snapshot.exists) {
        deleteExecApprovalsConfigRow(db);
      } else {
        const raw = snapshot.raw ?? serializeExecApprovals(snapshot.file);
        writeExecApprovalsConfigRow({ db, file: snapshot.file, raw });
      }
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

function requireInitializedExecApprovals(
  snapshot: ExecApprovalsSnapshot | null,
): ExecApprovalsSnapshot {
  if (!snapshot) {
    throw new Error("Failed to initialize exec approvals");
  }
  return snapshot;
}

function ensureExecApprovalsSnapshotSync(): ExecApprovalsSnapshot {
  const snapshot = readExecApprovalsSnapshot();
  if (
    snapshot.file.socket?.path?.trim() &&
    snapshot.file.socket.token?.trim() &&
    snapshot.raw === serializeExecApprovals(ensureExecApprovalsSocket(snapshot.file))
  ) {
    return snapshot;
  }
  return requireInitializedExecApprovals(
    updateExecApprovalsInTransaction({ update: ensureExecApprovalsSocket }),
  );
}

export async function ensureExecApprovalsSnapshot(): Promise<ExecApprovalsSnapshot> {
  return ensureExecApprovalsSnapshotSync();
}

export function ensureExecApprovals(): ExecApprovalsFile {
  return ensureExecApprovalsSnapshotSync().file;
}

const testing = {
  reset(): void {
    resetExecApprovalsMigrationGateForTest();
    lastWarnAt = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.execApprovalsStoreTestApi")] =
    testing;
}
