import { isMainThread } from "node:worker_threads";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  captureAgentDeletionDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  DeletedAgentSessionEntryPurgeParams,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import {
  captureNativeSessionWorkerDeletion,
  preparedSessionDeletionRequiresNativeTransaction,
  runSqliteSessionDeletionTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  prepareCommittedSessionEntryRemovals,
  publishCommittedSessionIdentity,
} from "./session-accessor.sqlite-identity.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
} from "./session-accessor.sqlite-maintenance.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  commitSessionAgentPurgeInDatabase,
  prepareSessionAgentPurgeInDatabase,
} from "./session-agent-purge.kernel.js";
import type {
  SessionAgentPurgeCommit,
  SessionAgentPurgeCommitted,
  SessionAgentPurgeResult,
} from "./session-agent-purge.types.js";
import { publishSessionStateArchivesInWorker } from "./session-archive-publication.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { runSessionNativeBindingWorkerOperation } from "./session-native-binding.js";
import { assertMaintenancePreservationCompatible } from "./store-maintenance-preserve-snapshot.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { normalizeResolvedMaintenanceConfigInput } from "./store-maintenance.js";

/** Retire logical entries without widening their selected transcript generations. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<void> {
  const resolved = captureLifecycleDatabaseScope(
    resolveSqliteScope({
      agentId: params.storeAgentId,
      env: params.env,
      sessionKey: "",
      storePath: params.storePath,
    }),
  );
  const database = { ...toDatabaseOptions(resolved), path: resolved.path };
  const execution =
    isMainThread && supportsOpenClawAgentDatabaseExecution(database)
      ? await captureAgentDeletionDatabaseExecution(database)
      : undefined;
  const selection = {
    cfg: structuredClone(params.cfg),
    agentId: params.agentId,
    storeAgentId: params.storeAgentId,
    archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
  };
  try {
    const prepared = execution
      ? await withSessionEntryWorker(
          database,
          undefined,
          () => execution.assertCurrent(),
          async (owner, source) => {
            await owner.prepare(source);
            const result = await owner.runExisting(source, (worker) =>
              worker.execute({ type: "session.agentPurge.prepare", input: selection }),
            );
            if (!result) {
              throw new Error("Session database disappeared before agent purge");
            }
            return result;
          },
          undefined,
          execution,
        )
      : await runExclusiveSqliteSessionWrite(
          resolved,
          async () =>
            prepareSessionAgentPurgeInDatabase(openOpenClawAgentDatabase(database), selection),
          "session.agent-purge.prepare",
        );
    execution?.assertCurrent();
    const materializedPlans = await materializeSessionStateDeletePlans(prepared.deletePlans);
    execution?.assertCurrent();
    const entries = prepared.entryRemovals.flatMap(({ expectedEntry: entry, sessionKey }) =>
      entry ? [{ entry, sessionKey }] : [],
    );
    const committed = await withSqliteSessionDeletions(
      resolved,
      entries,
      async (assertSourceCurrent) => {
        const native = !execution || preparedSessionDeletionRequiresNativeTransaction();
        const preservation = await prepareSessionMaintenancePreservation(params.storePath, {
          native,
        });
        const assertCurrent = () => {
          execution?.assertCurrent();
          assertSourceCurrent();
        };
        try {
          assertCurrent();
          if (native) {
            return await runExclusiveSqliteSessionWrite(
              resolved,
              async () => {
                const committedPurge = runSqliteSessionDeletionTransaction(
                  (current) => {
                    assertCurrent();
                    const result = commitSessionAgentPurgeInDatabase(
                      current,
                      { ...selection, ...prepared, materializedPlans },
                      (target) =>
                        applySessionEntryMaintenance(target, {
                          activeSessionKey: "",
                          archiveDirectory: selection.archiveDirectory,
                          storePath: params.storePath,
                          preservation: preservation.capture,
                          refreshCandidates: preservation.refreshCandidates,
                        }),
                    );
                    const publish = prepareCommittedSessionEntryRemovals(
                      resolved.agentId,
                      readOpenClawAgentDatabaseIdentity(current).identity,
                      prepared.entryRemovals,
                    );
                    assertCurrent();
                    return { ...result, publish };
                  },
                  database,
                  { operationLabel: "session.entry.purge-deleted-agent" },
                );
                committedPurge.publish();
                return committedPurge;
              },
              "session.agent-purge.commit",
            );
          }
          const sentPreservation = preservation.capture();
          const input: SessionAgentPurgeCommit = {
            ...selection,
            entryRemovals: prepared.entryRemovals,
            materializedPlans,
            maintenance: {
              activeSessionKey: "",
              archiveDirectory: selection.archiveDirectory,
              maintenance: normalizeResolvedMaintenanceConfigInput(resolveMaintenanceConfig()),
              preservation: sentPreservation,
              storePath: params.storePath,
            },
          };
          const operation: Omit<
            Parameters<
              typeof runSessionEntryWorkerOperation<
                SessionAgentPurgeCommitted,
                SessionAgentPurgeResult
              >
            >[0],
            "run"
          > = {
            database,
            agentId: resolved.agentId,
            retainedExecution: execution,
            assertCurrent,
            assertPrepared: () => {
              preservation.capture();
            },
            assertCandidate: (candidate) =>
              assertMaintenancePreservationCompatible(
                sentPreservation,
                preservation.capture(),
                candidate.result.maintenancePlans,
              ),
            candidateKind: "session-agent-purge",
            onCommitted(candidate, published, identity) {
              if (published) {
                publishCommittedSessionIdentity(
                  resolved.agentId,
                  identity,
                  published.previous,
                  published.current,
                  published.prepared,
                );
              }
              return candidate.result;
            },
          };
          const captured = captureNativeSessionWorkerDeletion(entries);
          return captured
            ? await runSessionNativeBindingWorkerOperation<
                SessionAgentPurgeCommitted,
                SessionAgentPurgeResult
              >({
                ...operation,
                captured,
                entries,
                execute: (worker, nativeBindings) =>
                  worker.execute({
                    type: "session.agentPurge.commit",
                    input: { ...input, nativeBindings },
                  }),
              })
            : await runSessionEntryWorkerOperation<
                SessionAgentPurgeCommitted,
                SessionAgentPurgeResult
              >({
                ...operation,
                run: (worker, commit) =>
                  commit(() => worker.execute({ type: "session.agentPurge.commit", input })),
              });
        } finally {
          preservation.dispose();
        }
      },
    );
    execution?.assertCurrent();
    const publishArchives = (requested: readonly SessionLifecycleArchivedTranscript[]) =>
      execution
        ? publishSessionStateArchivesInWorker({
            scope: resolved,
            requested,
            retainedExecution: execution,
            assertCurrent: () => execution.assertCurrent(),
          })
        : publishSessionStateArchives(resolved, requested);
    const { archivedTranscripts: maintenanceArchivedTranscripts } =
      await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
        resolved,
        committed.maintenancePlans,
        {
          deletedEntriesBeforeMaintenance: prepared.entryRemovals.length,
          retainedExecution: execution,
          publishArchives,
        },
      );
    execution?.assertCurrent();
    const archivedTranscripts = [
      ...(await publishArchives(committed.archivedTranscripts)),
      ...maintenanceArchivedTranscripts,
    ];
    emitArchivedTranscriptUpdates(archivedTranscripts);
  } finally {
    await execution?.release();
  }
}
