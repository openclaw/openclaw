import { AsyncLocalStorage } from "node:async_hooks";
import {
  createNativeSessionCommitFinalizer,
  getNativeSessionDeletionParticipant,
} from "../../agents/harness/native-session/deletion-participant.js";
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
  captureSessionTarget,
  isCompetingSessionControllerWorkActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  commitSessionInitializationRollback,
  getSessionInitializationRollback,
  type SessionInitialization,
} from "../../sessions/session-initialization.js";
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
  type MemorySessionDeletionSource,
  type SessionReceiptDeletionGeneration,
} from "./session-accessor.sqlite-deletion-receipts.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { resolveSessionDeletionWorkerParticipant } from "./session-deletion-worker-participant.js";
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
  settleReceipts: (assertCurrent?: () => void) => Promise<void>,
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

/** Includes worker-owned participants and host-only post-commit finalizers. */
export function hasPreparedNativeSessionDeletion(): boolean {
  const prepared = deletions.getStore();
  return (
    prepared !== undefined &&
    [...prepared.values()].some(
      (entry) => entry.mutations.length > 0 || entry.target.initialization !== undefined,
    )
  );
}

/** Capture native participants and host-only finalizers for the same worker commit. */
export function captureNativeSessionWorkerDeletion(entries: readonly DeletionEntry[]) {
  const captured = entries.map(({ sessionKey, entry }) => ({
    sessionKey,
    entry,
    prepared: deletions.getStore()?.get(sessionKey),
  }));
  const participants = [];
  for (const { sessionKey, entry, prepared } of captured) {
    if (!prepared) {
      continue;
    }
    for (const mutation of prepared.mutations) {
      const participant = resolveSessionDeletionWorkerParticipant(mutation, sessionKey);
      participants.push({ sessionKey, entry, participant });
    }
    const initialization = prepared.target.initialization;
    if (initialization) {
      const finalizer = createNativeSessionCommitFinalizer({
        commit: () => commitSessionInitializationRollback(initialization),
        rollback() {},
      });
      participants.push({
        sessionKey,
        entry,
        participant: getNativeSessionDeletionParticipant(finalizer)!,
      });
    }
  }
  if (participants.length === 0) {
    return undefined;
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
    receiptsOnCommit?: { generations: readonly SessionReceiptDeletionGeneration[] };
    memory?: MemorySessionDeletionSource;
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
  memory?: MemorySessionDeletionSource,
): Promise<T> {
  return withSqliteSessionMutations(scope, [entry], run, {
    contextReset: true,
    assertSourceCurrent,
    memory,
  });
}

async function withSqliteSessionMutations<T>(
  scope: Parameters<typeof withSqliteSessionDeletions>[0],
  entries: readonly DeletionEntry[],
  run: SessionMutationRun<T>,
  options: {
    additionalIdentities?: readonly string[];
    receiptsOnCommit?: { generations: readonly SessionReceiptDeletionGeneration[] };
    contextReset?: boolean;
    assertSourceCurrent?: () => void;
    memory?: MemorySessionDeletionSource;
  },
): Promise<T> {
  const memory = options.memory;
  if (memory) {
    memory.assertCurrent();
    if (memory.agentId !== scope.agentId || memory.path !== scope.path) {
      throw new Error("Session deletion differs from its captured memory owner");
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
      isCompetingSessionControllerWorkActive(ownerStorePath, [target.sessionKey, target.sessionId])
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
    !options.contextReset && !options.receiptsOnCommit && targets.length > 0
      ? pinSqliteSessionReceiptDeletionDatabase(databaseOptions, memory)
      : undefined;
  const execution =
    repositories && !memory && supportsOpenClawAgentDatabaseExecution(databaseOptions)
      ? captureOpenClawAgentDatabaseExecution(databaseOptions)
      : undefined;
  try {
    const repositoryWorkspaces = repositories
      ? await findSessionRepositoryWorkspaces(targets, { path: repositories.path, env: scope.env })
      : [];
    const invoke = async (
      prepared: ReadonlyMap<string, readonly PreparedAgentHarnessSessionDeletion[]>,
    ) => {
      const currentReads = new Map<
        string,
        Extract<CapturedSessionEntryCurrentRead, { kind: "file" }>
      >();
      const assertCurrent = () => {
        memory?.assertCurrent();
        if (repositoryWorkspaces.length > 0) {
          repositorySource?.admission.assertCurrent();
          execution?.assertCurrent();
        }
        for (const read of currentReads.values()) {
          read.assertSourceCurrent();
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
              return captured;
            },
          );
          currentReads.set(workspace.workspaceId, current);
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
      const receipts = await prepareSqliteSessionReceiptDeletions(receiptSource, targets, {
        receiptsOnCommit: options.receiptsOnCommit,
        repositorySessionKeys: repositoryWorkspaces.map((workspace) => workspace.sessionKey),
        env: scope.env,
        assertCurrent,
        assertRepositoryCurrent: () => repositorySource?.admission.assertCurrent(),
      });
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
            return await run(
              assertCurrent,
              (checkedEntries) => {
                assertActive();
                return captureSqliteSessionDeletionSettlement(checkedEntries, assertActive);
              },
              receipts.settleReceipts,
            );
          } finally {
            active = false;
            // Conversation deletion owns repository cleanup, including retained publication
            // sources after a Gateway move. History rotation and failed deletion keep the row.
            for (const workspace of repositoryWorkspaces) {
              const currentRead = currentReads.get(workspace.workspaceId);
              const assertSourceCurrent = () => {
                if (execution && !currentRead) {
                  throw new Error("Repository cleanup omitted its prepared session source");
                }
                repositorySource?.admission.assertCurrent();
                execution?.assertCurrent();
                currentRead?.assertSourceCurrent();
                memory?.assertCurrent();
              };
              const currentEntry = () =>
                memory
                  ? memory.readSession(workspace.sessionKey, {
                      assertCurrent: assertSourceCurrent,
                      authorize() {},
                    })?.entry
                  : readSessionEntryRow(
                      openOpenClawAgentDatabase(toDatabaseOptions(scope)),
                      workspace.sessionKey,
                    )?.entry;
              assertSourceCurrent();
              const present = currentRead
                ? (await currentRead.readCurrent()) !== undefined
                : currentEntry() !== undefined;
              if (present) {
                continue;
              }
              const sessionEntryCurrent = currentRead
                ? {
                    source: currentRead.source,
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
                if (!currentRead && currentEntry()) {
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
            await receipts.settlePresence();
          }
        },
      );
    };
    return await runSessionMutation({
      diagnosticLabel: "delete-prepare",
      targets: targets.map((target) =>
        captureSessionTarget({
          storeScope: ownerStorePath,
          // Legacy blank keys are addressed by incarnation until Doctor removes them.
          sessionKey: target.sessionKey.trim() ? target.sessionKey : target.sessionId,
          incarnation: target.sessionId,
          aliases: options.additionalIdentities,
        }),
      ),
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
  const prepared = checkedSessionDeletion(sessionKey, entry);
  if (!prepared) {
    return;
  }
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

function checkedSessionDeletion(sessionKey: string, entry: SessionEntry) {
  const prepared = deletions.getStore()?.get(sessionKey);
  if (!prepared) {
    if (captureAgentHarnessSessionDeletions()) {
      throw new Error(`Session deletion requires prepared harness ownership: ${sessionKey}`);
    }
    return undefined;
  }
  if (
    prepared.target.sessionId !== entry.sessionId ||
    prepared.target.lifecycleRevision !== entry.lifecycleRevision ||
    (prepared.contextReset && prepared.target.previousSessionId !== entry.previousSessionId)
  ) {
    throw new Error(`Session changed before deletion: ${sessionKey}`);
  }
  prepared.assertIdle();
  return prepared;
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
    async beforeCommit() {
      assertCurrent();
      if (entered || settled) {
        throw new Error("Session deletion companions already entered settlement");
      }
      entered = true;
      await runInOwner(async () => {
        for (const { sessionKey, entry } of captured) {
          const prepared = checkedSessionDeletion(sessionKey, entry)!;
          for (const mutation of prepared.mutations) {
            rollback.push(mutation);
            const participant = getNativeSessionDeletionParticipant(mutation);
            if (participant?.memoryMutation) {
              await participant.memoryMutation.commit(() => {
                assertCurrent();
                participant.assertCurrent();
              });
            } else {
              mutation.commit();
            }
          }
          if (prepared.target.initialization) {
            initializations.add(prepared.target.initialization);
          }
        }
      });
    },
    async settle(outcome: "committed" | "rolled-back" | "unknown") {
      if (settled) {
        throw new Error("Session deletion companions already settled");
      }
      settled = true;
      await runInOwner(async () => {
        if (outcome === "committed") {
          initializations.forEach(commitSessionInitializationRollback);
        } else if (outcome === "rolled-back") {
          const failures: unknown[] = [];
          for (const mutation of rollback.toReversed()) {
            try {
              const participant = getNativeSessionDeletionParticipant(mutation);
              if (participant?.memoryMutation) {
                await participant.memoryMutation.rollback(() => {
                  assertCurrent();
                  participant.assertCurrent();
                });
              } else {
                mutation.rollback();
              }
            } catch (error) {
              failures.push(error);
            }
          }
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
