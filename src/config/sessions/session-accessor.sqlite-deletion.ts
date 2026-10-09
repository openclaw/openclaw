import { AsyncLocalStorage } from "node:async_hooks";
import { getNativeSessionDeletionParticipant } from "../../agents/harness/native-session/deletion-participant.js";
import {
  captureAgentHarnessSessionDeletions,
  captureAgentHarnessSessionContextResets,
  type AgentHarnessSessionDeletionTarget,
  type PreparedAgentHarnessSessionDeletion,
} from "../../agents/harness/session-deletion.js";
import type { AgentHarnessSessionDeletionMutation } from "../../agents/harness/types.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  commitSessionInitializationRollback,
  getSessionInitializationRollback,
  type SessionInitialization,
} from "../../sessions/session-initialization.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../../state/github-personal-publication-lifecycle.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  createSessionRepositoryWorkspaceStore,
  findSessionRepositoryWorkspaces,
} from "../../state/session-repository-workspaces.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  pinSqliteSessionReceiptDeletionDatabase,
  prepareSqliteSessionReceiptDeletions,
  type IncognitoDeletionSource,
} from "./session-accessor.sqlite-deletion-receipts.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import type { SessionEntryCreateWithTranscriptOptions } from "./session-accessor.types.js";
import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentFacts,
} from "./session-entry-current.types.js";
import type { SessionEntry } from "./types.js";

type DeletionEntry = { sessionKey: string; entry: SessionEntry };
type SessionMutationRun<T> = (
  assertCurrent: () => void,
  captureSettlement: (
    entries: readonly DeletionEntry[],
  ) => ReturnType<typeof captureSqliteSessionDeletionSettlement>,
) => Promise<T>;
type PreparedDeletion = {
  target: AgentHarnessSessionDeletionTarget;
  mutations: readonly PreparedAgentHarnessSessionDeletion[];
  assertIdle: () => void;
  contextReset?: boolean;
};
const deletions = new AsyncLocalStorage<ReadonlyMap<string, PreparedDeletion>>();
const workerParticipant = new AsyncLocalStorage<
  (sessionKey: string, entry: SessionEntry) => void
>();

/** The executing owner supplies the typed precommit participant at the existing deletion edge. */
export function withSqliteSessionDeletionWorkerParticipant<T>(
  commit: (sessionKey: string, entry: SessionEntry) => void,
  run: () => T,
): T {
  return workerParticipant.run(commit, run);
}
const transactionMutations = new AsyncLocalStorage<{
  rollback: AgentHarnessSessionDeletionMutation[];
  initializations: Set<SessionInitialization>;
}>();

/** Worker commits cannot carry parent-thread native-owner rollback closures. */
export function hasPreparedNativeSessionDeletion(): boolean {
  const prepared = deletions.getStore();
  return (
    prepared !== undefined &&
    [...prepared.values()].some(
      (entry) => entry.mutations.length > 0 || entry.target.initialization !== undefined,
    )
  );
}

/** Initialization and opaque SDK callbacks retain their synchronous agent-row authority. */
export function preparedSessionDeletionRequiresNativeTransaction(): boolean {
  return [...(deletions.getStore()?.values() ?? [])].some(
    ({ target, mutations }) =>
      target.initialization !== undefined ||
      mutations.some((mutation) => !getNativeSessionDeletionParticipant(mutation)),
  );
}

/** Opaque SDK mutations keep their native transaction; only owner-minted participants qualify. */
export function captureNativeSessionWorkerDeletion(entries: readonly DeletionEntry[]) {
  if (preparedSessionDeletionRequiresNativeTransaction()) {
    return undefined;
  }
  const captured = entries.map(({ sessionKey, entry }) => ({
    sessionKey,
    entry,
    prepared: deletions.getStore()?.get(sessionKey),
  }));
  if (!captured.some(({ prepared }) => prepared?.mutations.length)) {
    return undefined;
  }
  const participants = [];
  for (const { sessionKey, entry, prepared } of captured) {
    if (!prepared) {
      return undefined;
    }
    for (const mutation of prepared.mutations) {
      const participant = getNativeSessionDeletionParticipant(mutation);
      if (!participant) {
        return undefined;
      }
      participants.push({ sessionKey, entry, participant });
    }
  }
  return {
    participants,
    assertCurrent() {
      for (const { prepared } of captured) {
        prepared?.assertIdle();
      }
    },
  };
}

type PreparedSessionWrite<T> = {
  deletedEntries: readonly DeletionEntry[];
  beforeCommit?: () => Promise<void>;
  commit: (assertSourceCurrent?: () => void) => T | Promise<T>;
};

/** Keep ordinary updates serialized; release the writer for preparation or source custody. */
export async function runPreparedSqliteSessionWrite<T>(
  initialScope: ResolvedSqliteReadScope,
  prepare: (scope: ResolvedSqliteReadScope) => Promise<PreparedSessionWrite<T>>,
  operation: SqliteSessionWriteOperation,
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"],
  prepareScope?: () => Promise<ResolvedSqliteReadScope>,
  scheduling: "foreground" | "worker" = "foreground",
): Promise<{ deletedEntries: number; result: Awaited<T>; scope: ResolvedSqliteReadScope }> {
  let scope = initialScope;
  const prepareWrite = async () => {
    if (prepareScope) {
      const preparedScope = await prepareScope();
      if (preparedScope.path !== scope.path) {
        throw new Error("Session write preparation changed its reserved database path");
      }
      scope = preparedScope;
    }
    const write = await prepare(scope);
    return scheduling === "worker" ||
      write.deletedEntries.length ||
      write.beforeCommit ||
      withCommit
      ? { write }
      : { result: await write.commit() };
  };
  // Worker phases acquire this same queue themselves; an outer foreground permit
  // would make their read admission wait behind its own preparation.
  const prepared =
    scheduling === "worker"
      ? await prepareWrite()
      : await runExclusiveSqliteSessionWrite(scope, prepareWrite, operation);
  if (!prepared.write) {
    return { deletedEntries: 0, result: prepared.result, scope };
  }
  const write = prepared.write;
  const commit = async (assertCurrent?: () => void) => {
    await write.beforeCommit?.();
    const runCommit = async (assertSourceCurrent?: () => void) => {
      const commitHeld = async () => {
        const assertHeld = () => {
          assertCurrent?.();
          assertSourceCurrent?.();
        };
        assertHeld();
        return await write.commit(assertHeld);
      };
      // Opaque native mutations stay on their original writer and ALS owner.
      return scheduling === "worker" &&
        (!hasPreparedNativeSessionDeletion() ||
          captureNativeSessionWorkerDeletion(write.deletedEntries))
        ? await commitHeld()
        : await runExclusiveSqliteSessionWrite(scope, commitHeld, operation);
    };
    return withCommit ? await withCommit(runCommit) : await runCommit();
  };
  const result =
    write.deletedEntries.length || write.beforeCommit
      ? await withSqliteSessionDeletions(scope, write.deletedEntries, commit)
      : await commit();
  return { deletedEntries: write.deletedEntries.length, result, scope };
}

/** Prepare owner leases before entering a physical writer or changing any transcript state. */
export async function withSqliteSessionDeletions<T>(
  scope: Pick<
    ResolvedSqliteReadScope,
    "agentId" | "databaseAgentId" | "env" | "ownerStorePath" | "path"
  >,
  entries: readonly DeletionEntry[],
  run: SessionMutationRun<T>,
  options: {
    additionalIdentities?: readonly string[];
    callerSettlesReceipts?: boolean;
    incognito?: IncognitoDeletionSource;
  } = {},
): Promise<T> {
  return withSqliteSessionMutations(scope, entries, run, options);
}

/** A context cut retires the native generation without deleting the session or its artifacts. */
export async function withSqliteSessionContextReset<T>(
  scope: Parameters<typeof withSqliteSessionDeletions>[0],
  entry: DeletionEntry,
  run: SessionMutationRun<T>,
  assertSourceCurrent?: () => void,
): Promise<T> {
  return withSqliteSessionMutations(scope, [entry], run, {
    contextReset: true,
    assertSourceCurrent,
  });
}

async function withSqliteSessionMutations<T>(
  scope: Parameters<typeof withSqliteSessionDeletions>[0],
  entries: readonly DeletionEntry[],
  run: SessionMutationRun<T>,
  options: {
    additionalIdentities?: readonly string[];
    callerSettlesReceipts?: boolean;
    contextReset?: boolean;
    assertSourceCurrent?: () => void;
    incognito?: IncognitoDeletionSource;
  },
): Promise<T> {
  const actor = options.incognito;
  if (actor) {
    actor.assertCurrent();
    if (actor.agentId !== scope.agentId || actor.path !== scope.path) {
      throw new Error("Session deletion differs from its captured incognito actor");
    }
  }
  const targets: AgentHarnessSessionDeletionTarget[] = [
    ...new Map(
      entries
        .filter(({ entry }) => entry.sessionId)
        .map(({ sessionKey, entry }) => [
          sessionKey,
          {
            agentId: parseAgentSessionKey(sessionKey)?.agentId ?? scope.agentId,
            sessionKey,
            sessionId: entry.sessionId,
            ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
            ...(entry.agentHarnessId ? { agentHarnessId: entry.agentHarnessId } : {}),
            ...(options.contextReset && entry.previousSessionId
              ? { previousSessionId: entry.previousSessionId }
              : {}),
          },
        ]),
    ).values(),
  ].toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
  const ownerStorePath =
    scope.ownerStorePath ??
    resolveSessionStorePathCore(undefined, { agentId: scope.agentId, env: scope.env });
  if (!options.contextReset) {
    for (const target of targets) {
      target.initialization = getSessionInitializationRollback({
        ...target,
        storePath: ownerStorePath,
      });
    }
  }
  const assertTargetIdle = (target: AgentHarnessSessionDeletionTarget) => {
    if (
      isCompetingSessionWorkAdmissionActive(ownerStorePath, [target.sessionKey, target.sessionId])
    ) {
      throw new Error(
        `Cannot mutate session while competing work is in flight for ${target.sessionKey}; retry after the run completes`,
      );
    }
  };
  targets.forEach(assertTargetIdle);
  const prepare = options.contextReset
    ? captureAgentHarnessSessionContextResets()
    : captureAgentHarnessSessionDeletions();
  const repositories = options.contextReset
    ? undefined
    : createSessionRepositoryWorkspaceStore({
        path: resolveOpenClawStateSqlitePath(scope.env),
        env: scope.env,
      });
  const repositorySource = repositories
    ? captureOpenClawStateWorkerContext({ path: repositories.path, env: scope.env })
    : undefined;
  const databaseOptions = toDatabaseOptions(scope);
  const receiptSource =
    !options.contextReset && !options.callerSettlesReceipts && targets.length > 0
      ? pinSqliteSessionReceiptDeletionDatabase(databaseOptions, actor)
      : undefined;
  const execution =
    repositories && supportsOpenClawAgentDatabaseExecution(databaseOptions)
      ? captureOpenClawAgentDatabaseExecution(databaseOptions)
      : undefined;
  try {
    const repositoryWorkspaces = repositories
      ? await findSessionRepositoryWorkspaces(targets, { path: repositories.path, env: scope.env })
      : [];
    const receiptOnlyTargets =
      !options.contextReset && !options.callerSettlesReceipts
        ? targets.filter(
            (target) =>
              !repositoryWorkspaces.some((workspace) => workspace.sessionKey === target.sessionKey),
          )
        : [];
    const invoke = async (
      prepared: ReadonlyMap<string, readonly PreparedAgentHarnessSessionDeletion[]>,
    ) => {
      const currentReads = new Map<
        string,
        {
          current: Extract<CapturedSessionEntryCurrentRead, { kind: "file" }>;
          readPresent: (assertSourceCurrent: () => void) => Promise<boolean>;
        }
      >();
      const assertCurrent = () => {
        actor?.assertCurrent();
        if (repositoryWorkspaces.length > 0) {
          repositorySource?.admission.assertCurrent();
          execution?.assertCurrent();
        }
        for (const read of currentReads.values()) {
          read.current.assertSourceCurrent();
        }
        targets.forEach(assertTargetIdle);
        for (const mutations of prepared.values()) {
          mutations.forEach((mutation) => mutation.assertCurrent());
        }
      };
      assertCurrent();
      if (execution && repositoryWorkspaces.length > 0) {
        const [{ captureSessionEntryCurrentRead }, { withSessionEntryReadOnlyInWorker }] =
          await Promise.all([
            import("./session-entry-current-runtime.js"),
            import("./session-entry-read-runtime.js"),
          ]);
        assertCurrent();
        for (const workspace of repositoryWorkspaces) {
          const readScope = {
            agentId: workspace.agentId,
            defaultAgentId: databaseOptions.agentId,
            storePath: scope.ownerStorePath ?? scope.path ?? ownerStorePath,
            sessionKey: workspace.sessionKey,
            env: scope.env,
          };
          const current = await withSessionEntryReadOnlyInWorker(
            readScope,
            assertCurrent,
            async (read, owner) => {
              if (!read.ok) {
                throw read.error;
              }
              const captured = captureSessionEntryCurrentRead(readScope, owner);
              execution.assertCurrent();
              if (
                captured.kind !== "file" ||
                captured.source.agentId !== execution.agentId ||
                !owner.scope
              ) {
                throw new Error("Repository cleanup lost its original file-backed session owner");
              }
              assertExistingDatabaseIdentity(
                execution.path,
                `file:${captured.source.databaseIdentity}`,
                captured.source.databaseBirthtime,
              );
              return { current: captured, scope: { ...owner.scope, projection: "full" as const } };
            },
          );
          currentReads.set(workspace.workspaceId, {
            current: current.current,
            readPresent: async (assertSourceCurrent) =>
              await withSessionEntryReadOnlyInWorker(
                current.scope,
                assertSourceCurrent,
                async (read, owner) => {
                  if (!read.ok) {
                    throw read.error;
                  }
                  const refreshed = captureSessionEntryCurrentRead(current.scope, owner);
                  const original = current.current.source;
                  if (
                    refreshed.kind !== "file" ||
                    refreshed.source.agentId !== original.agentId ||
                    refreshed.source.path !== original.path ||
                    refreshed.source.databaseIdentity !== original.databaseIdentity ||
                    refreshed.source.databaseBirthtime !== original.databaseBirthtime ||
                    refreshed.source.sessionKey !== original.sessionKey
                  ) {
                    throw new Error("Repository cleanup session source changed before deletion");
                  }
                  assertSourceCurrent();
                  return read.value !== undefined;
                },
              ),
          });
        }
      }
      const receiptDeletions = new Map<
        string,
        Awaited<ReturnType<typeof preparePersonalGitHubSessionReceiptDeletion>>
      >();
      for (const workspace of repositoryWorkspaces) {
        const target = targets.find((candidate) => candidate.sessionKey === workspace.sessionKey);
        if (!target) {
          throw new Error("Repository workspace deletion omitted its session target");
        }
        receiptDeletions.set(
          workspace.workspaceId,
          await preparePersonalGitHubSessionReceiptDeletion({
            agentId: workspace.agentId,
            env: scope.env,
            generations: [
              {
                sessionKey: workspace.sessionKey,
                sessionId: target.sessionId,
                lifecycleRevision: target.lifecycleRevision ?? null,
              },
            ],
            assertCurrent,
          }),
        );
      }
      const settleReceiptOnlyDeletions =
        receiptSource && receiptOnlyTargets.length > 0
          ? await prepareSqliteSessionReceiptDeletions(receiptSource, receiptOnlyTargets, {
              env: scope.env,
              assertCurrent,
              assertRepositoryCurrent: () => repositorySource?.admission.assertCurrent(),
            })
          : undefined;
      return await deletions.run(
        new Map(
          targets.map((target) => [
            target.sessionKey,
            {
              target,
              mutations: prepared.get(target.sessionKey) ?? [],
              assertIdle: () => assertTargetIdle(target),
              contextReset: options.contextReset,
            },
          ]),
        ),
        async () => {
          let active = true;
          const assertActive = () => {
            if (!active) {
              throw new Error("Session mutation preparation is no longer active");
            }
            assertCurrent();
          };
          try {
            return await run(assertCurrent, (checkedEntries) => {
              assertActive();
              return captureSqliteSessionDeletionSettlement(checkedEntries, assertActive);
            });
          } finally {
            active = false;
            // Conversation deletion owns repository cleanup, including retained publication
            // sources after a Gateway move. History rotation and failed deletion keep the row.
            for (const workspace of repositoryWorkspaces) {
              const currentRead = currentReads.get(workspace.workspaceId);
              const actorSnapshot = actor?.sessions.captureSnapshot(workspace.sessionKey);
              const assertSourceCurrent = () => {
                if (execution && !currentRead) {
                  throw new Error("Repository cleanup omitted its prepared session source");
                }
                repositorySource?.admission.assertCurrent();
                execution?.assertCurrent();
                currentRead?.current.assertSourceCurrent();
                actorSnapshot?.assertCurrent();
              };
              const currentEntry = () =>
                readSessionEntryRow(
                  openOpenClawAgentDatabase(toDatabaseOptions(scope)),
                  workspace.sessionKey,
                );
              assertSourceCurrent();
              const present = currentRead
                ? await currentRead.readPresent(assertSourceCurrent)
                : actor
                  ? actor.sessions.readSharing(workspace.sessionKey)?.entry !== undefined
                  : currentEntry() !== undefined;
              if (present) {
                continue;
              }
              const sessionEntryCurrent = currentRead
                ? {
                    source: currentRead.current.source,
                    assertCurrent: (entry: SessionEntryCurrentFacts | undefined) => {
                      assertSourceCurrent();
                      if (entry !== undefined) {
                        throw new Error("Repository workspace session changed before deletion");
                      }
                    },
                  }
                : undefined;
              const assertSessionAbsent = () => {
                assertSourceCurrent();
                if (
                  !currentRead &&
                  (actor ? actor.sessions.readSharing(workspace.sessionKey)?.entry : currentEntry())
                ) {
                  throw new Error("Repository workspace session changed before deletion");
                }
              };
              await receiptDeletions.get(workspace.workspaceId)!({
                assertCurrent: assertSessionAbsent,
                sessionEntryCurrent,
              });
              await repositories?.delete({
                workspaceId: workspace.workspaceId,
                sessionEntryCurrent,
                assertCurrent: assertSessionAbsent,
              });
            }
            await settleReceiptOnlyDeletions?.();
          }
        },
      );
    };
    return await runExclusiveSessionLifecycleMutation("delete-prepare", {
      scope: ownerStorePath,
      identities: [
        ...targets.flatMap((target) => [target.sessionKey, target.sessionId]),
        ...(options.additionalIdentities ?? []),
      ],
      run: async () =>
        prepare
          ? await prepare(targets, invoke, options.assertSourceCurrent)
          : await invoke(new Map()),
    });
  } finally {
    await execution?.release();
  }
}

/** Called only at the synchronous SQL edge, after the operation revalidates its row snapshot. */
export function commitSqliteSessionDeletion(sessionKey: string, entry: SessionEntry): void {
  const workerCommit = workerParticipant.getStore();
  if (workerCommit) {
    workerCommit(sessionKey, entry);
    return;
  }
  const prepared = deletions.getStore()?.get(sessionKey);
  if (!prepared) {
    if (captureAgentHarnessSessionDeletions()) {
      throw new Error(`Session deletion requires prepared harness ownership: ${sessionKey}`);
    }
    return;
  }
  if (
    prepared.target.sessionId !== entry.sessionId ||
    prepared.target.lifecycleRevision !== entry.lifecycleRevision ||
    (prepared.contextReset && prepared.target.previousSessionId !== entry.previousSessionId)
  ) {
    throw new Error(`Session changed before deletion: ${sessionKey}`);
  }
  prepared.assertIdle();
  const transaction = transactionMutations.getStore();
  if (!transaction) {
    throw new Error(`Session deletion requires its synchronous transaction: ${sessionKey}`);
  }
  for (const mutation of prepared.mutations) {
    transaction.rollback.push(mutation);
    mutation.commit();
  }
  if (prepared.target.initialization) {
    transaction.initializations.add(prepared.target.initialization);
  }
}

/** Retain host companions while their checked deletion commits in the worker. */
function captureSqliteSessionDeletionSettlement(
  entries: readonly DeletionEntry[],
  assertCurrent: () => void,
) {
  const captured = structuredClone(entries);
  for (const { sessionKey } of captured) {
    if (!deletions.getStore()?.has(sessionKey)) {
      throw new Error(`Session mutation target was not prepared: ${sessionKey}`);
    }
  }
  const runInOwner = AsyncLocalStorage.snapshot();
  const rollback: AgentHarnessSessionDeletionMutation[] = [];
  const initializations = new Set<SessionInitialization>();
  let entered = false;
  let settled = false;
  return {
    beforeCommit() {
      assertCurrent();
      if (entered || settled) {
        throw new Error("Session deletion companions already entered settlement");
      }
      entered = true;
      runInOwner(() =>
        transactionMutations.run({ rollback, initializations }, () => {
          for (const { sessionKey, entry } of captured) {
            commitSqliteSessionDeletion(sessionKey, entry);
          }
        }),
      );
    },
    settle(outcome: "committed" | "rolled-back" | "unknown") {
      if (settled) {
        throw new Error("Session deletion companions already settled");
      }
      settled = true;
      runInOwner(() => {
        if (outcome === "committed") {
          initializations.forEach(commitSessionInitializationRollback);
        } else if (outcome === "rolled-back") {
          const failures = rollbackSessionDeletionCompanions(rollback);
          if (failures.length > 0) {
            throw createSqliteLifecycleAggregateError(
              failures,
              "Session deletion rollback failed",
              failures[0],
            );
          }
        }
        // Unknown outcomes neither restore removed companions nor consume initialization.
      });
    },
  };
}

function rollbackSessionDeletionCompanions(
  mutations: readonly AgentHarnessSessionDeletionMutation[],
): unknown[] {
  const failures: unknown[] = [];
  for (const mutation of mutations.toReversed()) {
    try {
      mutation.rollback();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Roll back companion state only if SQLite failed before COMMIT, never after publication. */
export function runSqliteSessionDeletionTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  transactionOptions?: Parameters<typeof runOpenClawAgentWriteTransaction>[2],
): T {
  if (!deletions.getStore() || transactionMutations.getStore()) {
    return runOpenClawAgentWriteTransaction(operation, options, transactionOptions);
  }
  const rollback: AgentHarnessSessionDeletionMutation[] = [];
  const initializations = new Set<SessionInitialization>();
  let committed = false;
  try {
    return transactionMutations.run({ rollback, initializations }, () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          deferOpenClawAgentPostCommitPublication(database, () => {
            committed = true;
            initializations.forEach(commitSessionInitializationRollback);
          });
          return operation(database);
        },
        options,
        transactionOptions,
      ),
    );
  } catch (error) {
    const failures = [error];
    if (!committed) {
      failures.push(...rollbackSessionDeletionCompanions(rollback));
    }
    if (failures.length > 1) {
      throw createSqliteLifecycleAggregateError(
        failures,
        "Session deletion rollback failed",
        error,
      );
    }
    throw error;
  }
}
