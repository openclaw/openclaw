// Gateway startup owns admission; each store's existing migration owner writes in place.
import fs from "node:fs";
import path from "node:path";
import {
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
} from "../commands/doctor/shared/automatic-config-repair.js";
import { readConfigSnapshotBeforeEngineSelection } from "../config/io.factory.js";
import { resolveStateDir } from "../config/paths.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteIntegrityOperationSync } from "../infra/sqlite-integrity.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
} from "../infra/state-migrations.doctor.js";
import {
  logStateMigrationResult,
  throwIfDoctorStateMigrationRefused,
} from "../infra/state-migrations.messages.js";
import { prepareLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.js";
import { preflightPostgresUpgrade } from "../snapshot/database-backup.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import { openAgentEngineStore } from "./openclaw-agent-db-engine.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabaseForDoctor,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import {
  discoverDatabases,
  floorRaisingDatabases,
  outdatedDatabases,
  stateUpgradeRefusal,
} from "./state-upgrade-databases.js";
import {
  beginStateUpgradeRestore,
  pruneGenerations,
  publishStateUpgradeRestore,
  type StateUpgradeRestore,
} from "./state-upgrade-restore.js";

export type StateUpgradeResult =
  | { status: "current" | "upgraded" }
  | { status: "refused"; reason: string };

/** The caller retains exclusive state ownership through migration and native close. */
export async function upgradeStateDirectory(params: {
  env: NodeJS.ProcessEnv;
  log: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<StateUpgradeResult> {
  const { env, log } = params;
  const stateDir = path.resolve(resolveStateDir(env));
  if (!fs.existsSync(stateDir)) {
    return { status: "current" };
  }
  const snapshot = await readConfigSnapshotBeforeEngineSelection(env);
  const configRepair = await withArtifactPreservingStateReads(() =>
    planAutomaticConfigRepair(snapshot),
  );
  if (snapshot.exists && !snapshot.valid && !configRepair) {
    return {
      status: "refused",
      reason: `The config is invalid (${snapshot.issues
        .slice(0, 3)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}). Run openclaw config validate before retrying the update.`,
    };
  }
  const config = configRepair?.config ?? snapshot.config;
  const selection = await resolveDatabaseEngineSelection(config, env);
  return withDatabaseEngineSelection(selection, async (): Promise<StateUpgradeResult> => {
    const inventory = await discoverDatabases(stateDir, config, env);
    const outdated = outdatedDatabases(inventory.targets);
    const protectedTargets = floorRaisingDatabases(inventory.targets);
    let restore: StateUpgradeRestore | undefined;
    try {
      restore = await beginStateUpgradeRestore(env);
      if (restore) {
        const refusal = stateUpgradeRefusal(inventory, stateDir);
        if (refusal) {
          return { status: "refused", reason: refusal };
        }
      }
      await closeOpenClawStateDatabaseAsync();
      if (restore) {
        const postgres = protectedTargets.filter((target) => target.engine === "postgres");
        if (postgres.length > 0) {
          await preflightPostgresUpgrade(
            postgres.map((target) => target.path),
            config,
          );
        }
      }
      await publishStateUpgradeRestore(restore, { targets: protectedTargets, config });
    } catch (error) {
      return { status: "refused", reason: formatErrorMessage(error) };
    }
    const legacySessionSurfaces = await withArtifactPreservingStateReads(() =>
      prepareLegacySessionSurfaces({ config, env }),
    );
    const legacyState = await detectLegacyStateMigrations({
      cfg: config,
      env,
      doctorOnlyStateMigrations: true,
      artifactPreservingReadOnly: true,
      legacySessionSurfaces,
    });
    if (outdated.length === 0 && !configRepair && legacyState.preview.length === 0) {
      return { status: "current" };
    }
    try {
      // Released file formats still belong to Doctor's existing import owner.
      // It runs on live paths, after database images and before schema admission.
      if (legacyState.preview.length > 0) {
        const legacy = await autoMigrateLegacyState({
          cfg: config,
          env,
          doctorOnlyStateMigrations: true,
          configIncludedPaths: snapshot.includedPaths,
          legacySessionSurfaces,
        });
        logStateMigrationResult(legacy, log);
        throwIfDoctorStateMigrationRefused(legacy.stepReceipts);
      }
      if (configRepair) {
        await commitAutomaticConfigRepair(configRepair, snapshot);
      }
      for (const target of outdated.filter((entry) => entry.kind === "state")) {
        if (target.engine === "postgres") {
          await withEngineStoreAdmission(() =>
            openOpenClawStateDatabaseForDoctor({ path: target.path, env }),
          );
        } else {
          // This is the ordinary schema migration owner, not Doctor's repair chain.
          const migrated = await prepareOpenClawStateDatabaseSchema({ path: target.path, env });
          if (migrated.warnings.length > 0) {
            throw new Error(migrated.warnings.join("\n"), { cause: migrated.failure });
          }
        }
        log.info(`Migrated ${target.path} in place from schema ${target.version}.`);
      }
      const agents = outdated.filter((target) => target.kind === "agent");
      if (agents.length > 0) {
        await withAgentDatabaseMaintenanceLease(
          { env, processBound: true, schemaPolicy: "existing" },
          async (lease) => {
            for (const target of agents) {
              lease.assertOwned();
              using database = openNodeSqliteDatabase(target.path);
              if (target.engine === "postgres") {
                withEngineStoreAdmission(() => {
                  const engine = openAgentEngineStore(database, target.agentId!, target.path, true);
                  if (engine !== database) {
                    engine.close();
                  }
                });
              } else {
                runSqliteIntegrityOperationSync(
                  ensureOpenClawAgentDatabaseSchemaSteps(database, {
                    agentId: target.agentId!,
                    path: target.path,
                    env,
                    versionMigrationOnly: true,
                    onMigrationWarning: (warning) => log.warn(warning),
                  }),
                );
              }
              log.info(`Migrated ${target.path} in place from schema ${target.version}.`);
            }
          },
        );
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
    if (restore) {
      await pruneGenerations(
        stateDir,
        restore.generation,
        readPinnedVersions(path.join(stateDir, "state", "openclaw.sqlite")),
        new Set(protectedTargets.map((target) => target.path)),
        { config, activeAnchors: inventory.targets.map((target) => target.path), warn: log.warn },
      );
    }
    return { status: "upgraded" };
  });
}

/** Pins written by released generic rebuilds remain an operator recovery contract. */
function readPinnedVersions(statePath: string): Set<string> {
  try {
    using db = openNodeSqliteDatabase(statePath, { readOnly: true });
    return new Set(
      (
        db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
          // SAFETY: the statement fixes the column names and types of each row.
          .all("upgrade.pin") as Array<{ event_key: string }>
      ).map((row) => row.event_key),
    );
  } catch {
    return new Set();
  }
}

/** Never claim earlier committed database steps were undone after an I/O failure. */
export function explainMachineFailure(error: unknown, stateDir: string): unknown {
  // SAFETY: node:fs and node:sqlite report optional code/message fields on errors.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // SAFETY: only the optional Error message is read.
  const message = (error as Error | undefined)?.message ?? "";
  return code === "ENOSPC" ||
    code === "EIO" ||
    code === "EDQUOT" ||
    code === "EROFS" ||
    /SQLITE_FULL|database or disk is full|disk I\/O error/iu.test(message)
    ? new Error(
        `State migration to ${resolveRuntimeServiceBuildId() ?? VERSION} stopped: ${message}. Free disk space, keep the recovery files in ${stateDir}, and start the Gateway again.`,
        { cause: error },
      )
    : error;
}
