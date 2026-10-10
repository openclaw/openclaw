import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { waitForAgentDatabasePreparation } from "../../state/agent-database-preparation-context.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SqliteSessionArtifactPreparationDiagnostics,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { prepareSessionLifecycleArtifactCleanup } from "./session-accessor.sqlite-lifecycle-artifacts.js";
import { refreshSqliteSessionPlannerStatisticsBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import {
  createLifecycleArtifactReclamationPlan,
  runExclusiveSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteReadScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";
import { reclaimIncognitoSessionLifecycle } from "./session-incognito-lifecycle-operations.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

export async function cleanupSessionLifecycleArtifactsCore(
  params:
    | SessionLifecycleArtifactCleanupParams
    | ({ kind: "incognito" } & Parameters<typeof reclaimIncognitoSessionLifecycle>[0]),
): Promise<SessionLifecycleArtifactCleanupResult> {
  if ("kind" in params) {
    const result = await reclaimIncognitoSessionLifecycle(params);
    return {
      removedEntries: result.removedEntries,
      archivedTranscriptArtifacts: result.archivedTranscripts.length,
    };
  }
  const incognitoSource = captureIncognitoSessionSource(params);
  if (incognitoSource && "kind" in incognitoSource) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  const pluginOwnerId = params.pluginOwnerId?.trim();
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }
  if (incognitoSource) {
    return cleanupSessionLifecycleArtifactsCore({
      kind: "incognito",
      actor: incognitoSource.actor,
      authority: {
        assertCurrent() {
          incognitoSource.actor.assertCurrent();
        },
      },
      admissionSignal: incognitoSource.admissionSignal,
      env: params.env ?? {
        OPENCLAW_STATE_DIR: path.resolve(incognitoSource.actor.path, "../../../.."),
      },
      ownerStorePath: params.storePath,
      input: {
        sessionKeySegmentPrefix,
        transcriptContentMarker,
        pluginOwnerId,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs: params.nowMs ?? Date.now(),
      },
    });
  }

  const requested = captureLifecycleDatabaseScope(
    resolveSqliteReadScope({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      env: params.env,
      storePath: params.storePath,
    }),
  );
  const requestedOptions = toDatabaseOptions(requested);
  const preparation = waitForAgentDatabasePreparation(requestedOptions.agentId, {
    env: requested.env,
  });
  if (preparation) {
    await preparation;
  }
  const useWorker = isMainThread && supportsOpenClawAgentDatabaseExecution(requestedOptions);
  const opened = useWorker ? getOpenClawAgentDatabaseIfOpen(requestedOptions) : undefined;
  const openedIdentity = opened ? readOpenClawAgentDatabaseIdentity(opened) : undefined;
  const source = useWorker
    ? openedIdentity
      ? {
          key: `file:${String(openedIdentity.identity)}`,
          birthtime: openedIdentity.birthtime,
          canonicalPath: openedIdentity.filename,
        }
      : readDatabasePathIdentitySync(requested.path)
    : undefined;
  const resolved = { ...requested, path: source?.canonicalPath ?? requested.path };
  const databaseOptions = { ...toDatabaseOptions(resolved), path: resolved.path };
  return withSqliteMutationWorkerLifetime(databaseOptions, async ({ assertCurrent, signal }) => {
    const assertSourceCurrent = () => {
      assertCurrent();
      if (source) {
        const current = readDatabasePathIdentitySync(resolved.path);
        if (current.key !== source.key || current.birthtime !== source.birthtime) {
          throw new Error("SQLite lifecycle cleanup database owner changed");
        }
      }
    };
    const artifactPreparation: SqliteSessionArtifactPreparationDiagnostics = {};
    const cleanupPlan = await runExclusiveSqliteSessionWrite(
      resolved,
      async () => {
        assertSourceCurrent();
        const input = {
          ...(params.agentId !== undefined ? { agentId: resolved.agentId } : {}),
          archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts !== false,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          ...(pluginOwnerId ? { pluginOwnerId } : {}),
          sessionKeySegmentPrefix,
          transcriptContentMarker,
          orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
          nowMs: params.nowMs ?? Date.now(),
          diagnostics: artifactPreparation,
        };
        if (!source) {
          return prepareSessionLifecycleArtifactCleanup(databaseOptions, input);
        }
        const continuation = opened ? captureCanonicalSessionReaderContinuation(opened) : undefined;
        try {
          assertSourceCurrent();
          const result = await withSessionHistoryWorkerDatabase(
            databaseOptions,
            (owner) =>
              owner.readLifecycleArtifactPlan(
                {
                  env: resolved.env,
                  input: { ...input, continuation: continuation?.receipt },
                  expectedSource: source,
                },
                signal,
              ),
            maintenanceLane,
          );
          assertSourceCurrent();
          continuation?.assertCurrent();
          Object.assign(artifactPreparation, result.diagnostics);
          return result.plan;
        } finally {
          continuation?.release();
        }
      },
      "session.lifecycle.artifacts-prepare",
      { artifactPreparation },
    );
    assertSourceCurrent();
    if (cleanupPlan.entries.length === 0 && cleanupPlan.deletePlans.length === 0) {
      // Startup probes need no reclamation Worker, but previously committed archives
      // still need their publication retry even when this pass has no deletions.
      await publishSessionStateArchives(resolved, []);
      return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
    }
    const committed = await withSqliteSessionDeletions(
      resolved,
      cleanupPlan.entries.flatMap(({ expectedEntry: entry, sessionKey }) =>
        entry ? [{ entry, sessionKey }] : [],
      ),
      async (assertDeletionCurrent) =>
        await runExclusiveSqliteSessionReclamation(async () => {
          const assertCommitAllowed = () => {
            assertSourceCurrent();
            assertDeletionCurrent();
          };
          assertCommitAllowed();
          const materializedPlans = await materializeSessionStateDeletePlans(
            cleanupPlan.deletePlans,
          );
          assertCommitAllowed();
          const diagnostics: SqliteSessionReclamationDiagnostics = {};
          const plan = createLifecycleArtifactReclamationPlan({
            agentId: resolved.agentId,
            databaseOptions,
            entries: cleanupPlan.entries,
            materializedPlans,
          });
          const reclaimed = await runSqliteSessionReclamation({
            diagnostics,
            assertCommitAllowed,
            forceInProcess: hasPreparedNativeSessionDeletion(),
            plan,
          });
          if (reclaimed.kind !== plan.kind) {
            throw new Error(
              `SQLite session reclamation returned ${reclaimed.kind} for ${plan.kind}`,
            );
          }
          return reclaimed.value;
        }),
      { additionalIdentities: cleanupPlan.deletePlans.map((plan) => plan.sessionId) },
    );
    // The SQL commit survives a later archive-publication failure, so refresh
    // planner statistics before crossing that separate artifact boundary.
    const deletedEntries = Math.max(
      committed.removedEntries,
      new Set(cleanupPlan.deletePlans.map((plan) => plan.sessionId)).size,
    );
    assertSourceCurrent();
    await refreshSqliteSessionPlannerStatisticsBestEffort(resolved, deletedEntries);
    assertSourceCurrent();
    const archivedTranscripts = await publishSessionStateArchives(
      resolved,
      committed.archivedTranscripts,
    );
    return {
      removedEntries: committed.removedEntries,
      archivedTranscriptArtifacts: archivedTranscripts.length,
    };
  });
}
