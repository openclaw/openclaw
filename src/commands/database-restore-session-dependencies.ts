import { formatInvalidConfigRepairHint } from "../cli/config-recovery-hints.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import {
  createConfigReadError,
  createInvalidConfigError,
  formatInvalidConfigDetails,
  isConfigReadFailure,
} from "../config/io.invalid-config.js";
import { readResolvedSessionEntryInWorker } from "../config/sessions/session-accessor.entry-read-runtime.js";
import { restoreRetainedWorkerOwnerInDatabase } from "../gateway/worker-environments/retained-owner-recovery.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  assertSkillLibraryRecoveryOwnerInDatabase,
  restoreSkillLibraryRevisionInDatabase,
} from "../skills/library/recovery.js";
import { ensureSkillLibrarySchema } from "../skills/library/store.js";
import { ensureSessionRepositoryWorkspaceSchema } from "../state/openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { restoreRepositoryWorkspaceInDatabase } from "../state/session-repository-workspaces.recovery.js";
import { readConfigSnapshotForEngineSelection } from "./config-preflight-snapshot.js";
import {
  prepareSessionDependencyArtifacts,
  publishSessionDependencyArtifacts,
} from "./database-restore-session-dependencies.artifacts.js";
import { readSessionDependencyInput } from "./database-restore-session-dependencies.input.js";
import { assertRetainedRecoveryProfile } from "./database-restore-session-dependencies.retained.js";

/** Restore only the dependencies an existing session selected, under exclusive offline custody. */
export async function restoreSessionDependencies(options: { input: string; sha256: string }) {
  const input = await readSessionDependencyInput(options.input, options.sha256);
  const artifacts = await prepareSessionDependencyArtifacts(input);
  const snapshot = await readConfigSnapshotForEngineSelection();
  if (!snapshot.valid) {
    const details =
      formatInvalidConfigDetails(snapshot.issues) +
      "\n" +
      formatInvalidConfigRepairHint(snapshot, "to repair, then retry.");
    if (isConfigReadFailure(snapshot)) {
      throw createConfigReadError(snapshot, details);
    }
    throw createInvalidConfigError(snapshot.path, details);
  }
  return runWithLocalStateOwner({
    method: "database.restore-session-dependencies",
    params: {},
    target: resolveOpenClawStateSqlitePath(process.env),
    onForeignOwner: "refuse",
    databaseEngine: "configured",
    runLocal: async ({ env, config, assertCurrent }) => {
      const assertSession = async () => {
        const entry = await readResolvedSessionEntryInWorker({
          cfg: config,
          env,
          agentId: input.request.agentId,
          sessionKey: input.request.sessionKey,
        });
        assertCurrent();
        if (
          !entry ||
          entry.sessionId !== input.request.sessionId ||
          entry.repositoryWorkspaceId !== input.request.workspaceId ||
          !entry.skillLibrarySelections?.some(
            (pin) =>
              pin.skillId === input.request.skillId &&
              pin.revision === input.request.skillRevision &&
              pin.ownerProfileId === input.request.profileId,
          )
        ) {
          throw new Error("Current session no longer selects the exact dependency closure");
        }
      };
      await assertSession();
      if (input.retained) {
        assertRetainedRecoveryProfile(config, input.retained.source);
      }
      const database = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env }));
      try {
        withEngineStoreAdmission(() => {
          ensureSkillLibrarySchema({ env, database }, assertCurrent);
          ensureSessionRepositoryWorkspaceSchema(database.db);
        });
        const assertRecoveryOwner = () => {
          assertCurrent();
          // Offline custody permits native reads; publication never borrows historical authority.
          withEngineStoreAdmission(() =>
            assertSkillLibraryRecoveryOwnerInDatabase(
              database.db,
              input.rows,
              input.request.profileId,
            ),
          );
        };
        await publishSessionDependencyArtifacts(
          input,
          artifacts,
          database.path,
          env,
          assertRecoveryOwner,
        );
        await assertSession();
        const result = withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              assertCurrent();
              const skill = restoreSkillLibraryRevisionInDatabase(
                db,
                input.rows,
                input.request.profileId,
              );
              const workspace = input.retained
                ? {
                    retainedOwner: restoreRetainedWorkerOwnerInDatabase(
                      database,
                      { ...input.retained, assertCurrent },
                      Date.now(),
                    ),
                    executionReady: false,
                  }
                : restoreRepositoryWorkspaceInDatabase(db, input.rows.workspace);
              assertCurrent();
              return { ...skill, ...workspace };
            },
            { env, database },
            { operationLabel: "session-dependencies.restore" },
          ),
        );
        return { ok: true, ...input.request, ...result };
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    },
  });
}
