import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { find as findPlacement } from "../gateway/worker-environments/placement-row-codec.js";
import type { RetainedWorkerOwnerRecoverySource } from "../gateway/worker-environments/retained-owner-recovery.js";
import { snapshotWorkerAllocationProfile } from "../gateway/worker-environments/service-validation.js";
import { findWorkerEnvironment } from "../gateway/worker-environments/store-row-codec.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { normalizeCapabilityProviderId } from "../plugins/provider-registry-shared.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { readSessionRepositoryWorkspaceInDatabase } from "../state/session-repository-workspaces.kernel.js";

/** Source and expected images use the current owners' codecs, never fork-era schema adapters. */
export function readRetainedRecoveryRecords(
  db: EngineConnection,
  selection: {
    workspaceId: string;
    sessionId: string;
    environmentId: string;
  },
) {
  return {
    environment: findWorkerEnvironment(db, selection.environmentId) ?? null,
    placement: findPlacement(db, selection.sessionId) ?? null,
    workspace: readSessionRepositoryWorkspaceInDatabase(db, selection.workspaceId) ?? null,
  };
}

export function readRetainedRecoverySource(
  db: EngineConnection,
  selection: {
    workspaceId: string;
    sessionId: string;
    environmentId: string;
  },
): RetainedWorkerOwnerRecoverySource {
  const records = readRetainedRecoveryRecords(db, selection);
  if (!records.environment || !records.workspace || records.placement?.state !== "active") {
    throw new Error("Selected source has no complete active retained dependency owner");
  }
  const query = getNodeSqliteKysely<DB>(db);
  return {
    environment: records.environment,
    placement: records.placement,
    workspace: records.workspace,
    hasPendingWorkspaceResult: Boolean(
      executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("worker_workspace_pending_results")
          .select("session_id")
          .where("session_id", "=", selection.sessionId),
      ),
    ),
    hasPlacementMove: Boolean(
      executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("worker_session_placement_moves")
          .select("session_id")
          .where("session_id", "=", selection.sessionId),
      ),
    ),
    hasRunningToolOperation: Boolean(
      executeSqliteQueryTakeFirstSync(
        db,
        query
          .selectFrom("worker_session_tool_operations")
          .select("source_session_id")
          .where("source_session_id", "=", selection.sessionId)
          .where("status", "=", "running"),
      ),
    ),
  };
}

/** Current operator configuration remains authoritative; recovery never restores provider settings. */
export function assertRetainedRecoveryProfile(
  config: OpenClawConfig,
  source: RetainedWorkerOwnerRecoverySource,
) {
  const { environment } = source;
  const profile = config.cloudWorkers?.profiles?.[environment.profileId];
  // Allocation selection and project metadata are historical custody, not configuration.
  const { install, settings, workspaceDurability } = environment.profileSnapshot;
  const configuredSnapshot = {
    install,
    settings,
    ...(workspaceDurability ? { workspaceDurability } : {}),
  };
  if (
    !profile ||
    normalizeCapabilityProviderId(profile.provider) !== environment.providerId ||
    !isDeepStrictEqual(snapshotWorkerAllocationProfile(profile), configuredSnapshot)
  ) {
    throw new Error("Current worker profile differs from the selected retained acquisition");
  }
}
