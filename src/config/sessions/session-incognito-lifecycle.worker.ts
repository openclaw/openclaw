import { isDeepStrictEqual } from "node:util";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseIncognitoIdentity } from "../../state/openclaw-agent-execution-contract.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive-types.js";
import { prepareSessionDeletionInDatabase } from "./session-accessor.sqlite-deletion-plan.js";
import { withSqliteSessionDeletionWorkerParticipant } from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { planSessionLifecycleArtifactCleanup } from "./session-accessor.sqlite-lifecycle-artifacts.js";
import { mutateSqliteSessionAtMessageInTransaction } from "./session-accessor.sqlite-message-cut.js";
import {
  buildForkedChildTranscriptEvents,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { reclaimSqliteSessionInTransaction } from "./session-accessor.sqlite-reclamation.js";
import { formatLegacySqliteSessionMarkerForScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  incognitoLifecycleKeys,
  type IncognitoLifecycleEntry,
  type IncognitoLifecycleOperations,
} from "./session-incognito-lifecycle-contract.js";
import {
  commitParentForkInTransaction,
  prepareParentForkEntry,
  readParentForkSource,
} from "./session-parent-fork.worker.js";

type Command = SqliteWorkerCommand<IncognitoLifecycleOperations>;

/** Uses the admitted actor connection; archive materialization is never an incognito operation. */
export function createIncognitoLifecycleWorker(
  database: OpenClawAgentDatabase,
  identity: AgentDatabaseIncognitoIdentity,
  env: SqliteWorkerStateContext["environment"],
  admit: (
    stage: "transaction" | "commit",
    keys: readonly string[],
    receipt?: { value: unknown },
  ) => void,
) {
  const databaseOptions = { agentId: database.agentId, path: database.path, env };
  const assertEntry = (target: IncognitoLifecycleEntry) => {
    const entry = readExactSessionEntryRow(database, target.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(entry, target.entry)) {
      throw new Error("Incognito lifecycle session changed before mutation");
    }
    return target.entry;
  };
  const materialize = (
    plans: readonly SessionStateDeletePlan[],
    reason?: SessionStateDeletePlan["reason"],
  ): MaterializedSessionStateDeletePlan[] =>
    plans.map((plan) => {
      if (
        plan.agentId !== database.agentId ||
        plan.databasePath !== database.path ||
        plan.archiveTranscript
      ) {
        throw new Error("Incognito reclamation cannot change its actor or create an archive");
      }
      return { ...plan, reason: reason ?? plan.reason, archive: null, archivedTranscript: null };
    });
  const write = <T>(keys: readonly string[], operation: () => T, receipt = false): T =>
    withSqlitePostCommitPublications(database.db, () =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Incognito lifecycle lost its native owner");
          }
          admit("transaction", keys);
          const value = operation();
          admit("commit", keys, receipt ? { value } : undefined);
          return value;
        },
        databaseOptions,
        { operationLabel: "session.incognito.lifecycle" },
      ),
    );

  return {
    execute(command: Command) {
      const keys = incognitoLifecycleKeys(command, identity);
      switch (command.type) {
        case "session.lifecycle.maintenance": {
          const { plan } = command.input;
          const materializedPlans = materialize(plan.deletePlans);
          const value = write(
            keys,
            () => {
              const result = reclaimSqliteSessionInTransaction({
                kind: "maintenance-finalize",
                agentId: database.agentId,
                databaseOptions,
                entries: plan.entries,
                materializedPlans,
              });
              if (result.kind !== "maintenance-finalize") {
                throw new Error("Incognito maintenance returned another operation");
              }
              return result.value;
            },
            true,
          );
          return { value, keys };
        }
        case "session.lifecycle.messageCut": {
          const value = write(
            keys,
            () => {
              let projectionNeedsReconcile = false;
              const result = withSqliteSessionDeletionWorkerParticipant(
                () => {},
                () =>
                  mutateSqliteSessionAtMessageInTransaction(
                    database,
                    { ...databaseOptions, sessionKey: command.input.intent.sourceKey },
                    command.input.intent,
                    {
                      sourceRepositoryWorkspaceId: command.input.sourceRepositoryWorkspaceId,
                      scheduleProjectionReconcile: false,
                      onProjectionReconcileNeeded: () => {
                        projectionNeedsReconcile = true;
                      },
                    },
                  ),
              );
              return { result, projectionNeedsReconcile };
            },
            true,
          );
          return { value, keys };
        }
        case "session.lifecycle.parentFork.prepare":
          return { value: prepareParentForkEntry(command.input, { open: () => database }), keys };
        case "session.lifecycle.parentFork.source": {
          const entry = readExactSessionEntryRow(database, command.input.sessionKey)?.entry;
          if (entry?.sessionId !== command.input.sessionId) {
            throw new Error("Incognito parent fork source changed before reading");
          }
          return { value: readParentForkSource(command.input, { open: () => database }), keys };
        }
        case "session.lifecycle.parentFork.commit":
          return {
            value: write(keys, () => {
              const input = command.input;
              if (input.kind === "transcript" && input.source === undefined) {
                assertEntry({
                  sessionKey: input.params.parentSessionKey,
                  entry: input.params.parentEntry,
                });
              }
              return commitParentForkInTransaction(database, input, databaseOptions);
            }),
            keys,
          };
        case "session.lifecycle.delete": {
          const { target, reason, admissionIdentities, expectedPluginOwnerId } = command.input;
          assertEntry(target);
          const deleteParams = {
            storePath: database.path,
            target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
            expectedEntry: target.entry,
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
            deleteDeliveryArtifacts: true,
          };
          const planned = prepareSessionDeletionInDatabase(database, {
            operation: "entry",
            input: {
              deleteParams,
              archiveDirectory: "",
              admissionIdentities,
              allowLockedEntryRemoval: Boolean(expectedPluginOwnerId),
              expectedPluginOwnerId,
            },
          });
          if (planned.operation !== "entry" || planned.value.kind !== "ready") {
            throw new Error("Incognito deletion lost its prepared session");
          }
          const prepared = planned.value.value;
          const plans = [...prepared.entryPlans];
          for (const sessionId of prepared.historicalGenerationIds) {
            const history = prepareSessionDeletionInDatabase(database, {
              operation: "history",
              input: {
                validation: {
                  deleteParams,
                  preparedTargetSnapshot: prepared.targetSnapshot,
                  scope: { kind: "historical-generation", phase: "plan", sessionId },
                },
                sessionId,
                admissionIdentities,
                archiveDirectory: "",
                archiveTranscript: false,
              },
            });
            if (
              history.operation !== "history" ||
              history.value.kind === "expected-entry-mismatch"
            ) {
              throw new Error("Incognito history changed before deletion");
            }
            if (history.value.kind === "ready") {
              plans.push(history.value.plan);
            }
          }
          const materializedPlans = materialize(plans, reason);
          const value = write(keys, () => {
            assertEntry(target);
            const result = reclaimSqliteSessionInTransaction({
              kind: "entry",
              databaseOptions,
              deleteParams,
              preparedTargetSnapshot: prepared.targetSnapshot,
              materializedPlans,
            });
            if (result.kind !== "entry" || !result.value.deleted) {
              throw new Error("Incognito deletion did not remove its checked session");
            }
            return result.value;
          });
          return { value, keys };
        }
        case "session.lifecycle.reclaim.prepare": {
          const value = planSessionLifecycleArtifactCleanup(database, {
            ...command.input,
            agentId: database.agentId,
            archiveDirectory: "",
            archiveRemovedEntryTranscripts: false,
          });
          return {
            value: { ...value, identity },
            keys: value.entries.map(({ sessionKey }) => sessionKey),
          };
        }
        case "session.lifecycle.reclaim": {
          const { plan } = command.input;
          if (!isDeepStrictEqual(plan.identity, identity)) {
            throw new Error("Incognito reclamation belongs to another actor");
          }
          const materializedPlans = materialize(plan.deletePlans);
          const value = write(keys, () => {
            const result = reclaimSqliteSessionInTransaction({
              kind: "lifecycle-artifacts",
              agentId: database.agentId,
              databaseOptions,
              entries: plan.entries,
              materializedPlans,
            });
            if (result.kind !== "lifecycle-artifacts") {
              throw new Error("Incognito reclamation returned another operation");
            }
            return result.value;
          });
          return { value, keys };
        }
        case "session.lifecycle.fork.prepare": {
          const { parent, forkFrom } = command.input;
          const entry = assertEntry(parent);
          assertModelSelectionUnlocked(entry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
          const source = resolveParentForkSourceTranscript(
            loadTranscriptEventsFromDatabase(database, entry.sessionId),
            forkFrom,
          );
          const value = source
            ? {
                ...parent,
                identity,
                source,
                version: readTranscriptContextVersionInTransaction(database, entry.sessionId),
                parentSessionFile: formatLegacySqliteSessionMarkerForScope({
                  ...databaseOptions,
                  sessionKey: parent.sessionKey,
                  sessionId: entry.sessionId,
                }),
              }
            : undefined;
          return { value, keys };
        }
        case "session.lifecycle.fork": {
          const { parent, child } = command.input;
          if (
            parent.sessionKey === child.sessionKey ||
            parent.entry.sessionId === child.entry.sessionId
          ) {
            throw new Error("Incognito fork requires a distinct child session");
          }
          const events = buildForkedChildTranscriptEvents({
            parentSessionFile: parent.parentSessionFile,
            source: parent.source,
            targetSessionId: child.entry.sessionId,
          });
          const value = write(keys, () => {
            if (isDeepStrictEqual(parent.identity, identity)) {
              assertEntry(parent);
              const version = readTranscriptContextVersionInTransaction(
                database,
                parent.entry.sessionId,
              );
              if (!isDeepStrictEqual({ ...version }, { ...parent.version })) {
                throw new Error("Incognito fork source transcript changed before mutation");
              }
            }
            const previous = readExactSessionEntryRow(database, child.sessionKey)?.entry;
            if (!sqliteSessionEntriesEqual(previous, child.expectedEntry)) {
              throw new Error("Incognito fork child changed before mutation");
            }
            const entry = writeSessionEntry(
              database,
              child.sessionKey,
              {
                ...child.entry,
                incognito: true,
                forkSource: { sessionKey: parent.sessionKey, sessionId: parent.entry.sessionId },
                forkedFromParent: true,
                lifecycleRunId: undefined,
                lastRunId: undefined,
                totalTokens: undefined,
                totalTokensFresh: false,
                totalTokensVersion: undefined,
                cliSessionBindings: command.input.cliSessionBindings,
                cliSessionIds: undefined,
                claudeCliSessionId: undefined,
              },
              { previousEntry: previous ?? null },
            );
            appendTranscriptEventsInTransaction(
              database,
              { ...databaseOptions, sessionKey: child.sessionKey, sessionId: entry.sessionId },
              events,
            );
            return entry;
          });
          return { value, keys };
        }
      }
      throw new Error("Unsupported incognito lifecycle operation");
    },
  };
}
