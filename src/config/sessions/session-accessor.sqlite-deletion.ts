import { AsyncLocalStorage } from "node:async_hooks";
import {
  captureAgentHarnessSessionDeletions,
  captureAgentHarnessSessionContextResets,
  type AgentHarnessSessionDeletionTarget,
  type PreparedAgentHarnessSessionDeletion,
} from "../../agents/harness/session-deletion.js";
import type { AgentHarnessSessionDeletionMutation } from "../../agents/harness/types.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
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
import { deletePersonalGitHubSessionReceipts } from "../../state/github-personal-publication-lifecycle.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createSessionRepositoryWorkspaceStore,
  findSessionRepositoryWorkspaces,
} from "../../state/session-repository-workspaces.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import type { SessionEntryCreateWithTranscriptOptions } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

type DeletionEntry = { sessionKey: string; entry: SessionEntry };
type PreparedDeletion = {
  target: AgentHarnessSessionDeletionTarget;
  mutations: readonly PreparedAgentHarnessSessionDeletion[];
  assertIdle: () => void;
  contextReset?: boolean;
};
const deletions = new AsyncLocalStorage<ReadonlyMap<string, PreparedDeletion>>();
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
): Promise<{ deletedEntries: number; result: Awaited<T>; scope: ResolvedSqliteReadScope }> {
  let scope = initialScope;
  const prepared = await runExclusiveSqliteSessionWrite(
    scope,
    async () => {
      if (prepareScope) {
        const preparedScope = await prepareScope();
        if (preparedScope.path !== scope.path) {
          throw new Error("Session write preparation changed its reserved database path");
        }
        scope = preparedScope;
      }
      const write = await prepare(scope);
      return write.deletedEntries.length || write.beforeCommit || withCommit
        ? { write }
        : { result: await write.commit() };
    },
    operation,
  );
  if (!prepared.write) {
    return { deletedEntries: 0, result: prepared.result, scope };
  }
  const write = prepared.write;
  const commit = async (assertCurrent?: () => void) => {
    await write.beforeCommit?.();
    const runCommit = async (assertSourceCurrent?: () => void) =>
      await runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          const assertHeld = () => {
            assertCurrent?.();
            assertSourceCurrent?.();
          };
          assertHeld();
          return await write.commit(assertHeld);
        },
        operation,
      );
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
  run: (assertCurrent: () => void) => Promise<T>,
  options: { additionalIdentities?: readonly string[] } = {},
): Promise<T> {
  return withSqliteSessionMutations(scope, entries, run, options);
}

/** A context cut retires the native generation without deleting the session or its artifacts. */
export async function withSqliteSessionContextReset<T>(
  scope: Parameters<typeof withSqliteSessionDeletions>[0],
  entry: DeletionEntry,
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  return withSqliteSessionMutations(scope, [entry], run, { contextReset: true });
}

async function withSqliteSessionMutations<T>(
  scope: Parameters<typeof withSqliteSessionDeletions>[0],
  entries: readonly DeletionEntry[],
  run: (assertCurrent: () => void) => Promise<T>,
  options: { additionalIdentities?: readonly string[]; contextReset?: boolean },
): Promise<T> {
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
    : createSessionRepositoryWorkspaceStore({ path: resolveOpenClawStateSqlitePath(scope.env) });
  const repositoryWorkspaces = repositories
    ? await findSessionRepositoryWorkspaces(targets, { path: repositories.path, env: scope.env })
    : [];
  const invoke = async (
    prepared: ReadonlyMap<string, readonly PreparedAgentHarnessSessionDeletion[]>,
  ) => {
    const assertCurrent = () => {
      targets.forEach(assertTargetIdle);
      for (const mutations of prepared.values()) {
        mutations.forEach((mutation) => mutation.assertCurrent());
      }
    };
    assertCurrent();
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
        try {
          return await run(assertCurrent);
        } finally {
          // Conversation deletion owns repository cleanup, including retained publication
          // sources after a Gateway move. History rotation and failed deletion keep the row.
          for (const workspace of repositoryWorkspaces) {
            const currentEntry = () =>
              readSessionEntryRow(
                openOpenClawAgentDatabase(toDatabaseOptions(scope)),
                workspace.sessionKey,
              );
            if (currentEntry()) {
              continue;
            }
            deletePersonalGitHubSessionReceipts({
              agentId: workspace.agentId,
              env: scope.env,
              sessionKeys: [workspace.sessionKey],
            });
            await repositories?.delete({
              workspaceId: workspace.workspaceId,
              assertCurrent: () => {
                if (currentEntry()) {
                  throw new Error("Repository workspace session changed before deletion");
                }
              },
            });
          }
        }
      },
    );
  };
  return await runExclusiveSessionLifecycleMutation({
    scope: ownerStorePath,
    identities: [
      ...targets.flatMap((target) => [target.sessionKey, target.sessionId]),
      ...(options.additionalIdentities ?? []),
    ],
    run: async () => (prepare ? await prepare(targets, invoke) : await invoke(new Map())),
  });
}

/** Called only at the synchronous SQL edge, after the operation revalidates its row snapshot. */
export function commitSqliteSessionDeletion(sessionKey: string, entry: SessionEntry): void {
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
      for (const mutation of rollback.toReversed()) {
        try {
          mutation.rollback();
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
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
