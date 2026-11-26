// Gateway startup owns admission; each store's existing migration owner writes in place.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import {
  hasPendingSharedAuthCleanup,
  inspectSharedAuthLegacySourceFile,
} from "../agents/auth-profiles/shared-store-bootstrap.js";
import { normalizeHeartbeatRepairSource } from "../commands/doctor-automatic-heartbeat-repair.js";
import { tryProjectRetiredHeartbeatConfig } from "../commands/doctor-heartbeat-legacy.js";
import { retireHeartbeatWithDoctor } from "../commands/doctor-heartbeat-retirement.js";
import {
  backupDoctorMigrationDatabases,
  captureFreshDoctorMigrationTables,
} from "../commands/doctor-migration-backup.js";
import {
  planLegacyConfigForUpdateChannel,
  repairLegacyConfigForUpdateChannel,
} from "../commands/doctor/legacy-config-repair.js";
import {
  commitAutomaticConfigRepair,
  planAutomaticConfigRepair,
} from "../commands/doctor/shared/automatic-config-repair.js";
import { createConfigIO, readConfigSnapshotBeforeEngineSelection } from "../config/io.factory.js";
import { resolveConfigIncludeWriteBoundary } from "../config/mutate.js";
import { resolveStateDir } from "../config/paths.js";
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
import type { LegacyStateDetection } from "../infra/state-migrations.types.js";
import {
  recordDoctorMigrationFullBackup,
  runWithDoctorMigrationBackup,
} from "../infra/update-doctor-migration-attribution.js";
import { prepareLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.js";
import { preflightPostgresUpgrade } from "../snapshot/database-backup.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import { openAgentEngineStore } from "./openclaw-agent-db-engine.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabaseForDoctor,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import {
  discoverDatabases,
  expectedVersion,
  floorRaisingDatabases,
  hasLegacyStateSources,
  isUpgradeRestorePath,
  outdatedDatabases,
  stateUpgradeRefusal,
  type DatabaseTarget,
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
  const selectedSnapshot = await readConfigSnapshotBeforeEngineSelection(env);
  const { snapshot, writeOptions } = await createConfigIO({
    env,
    configPath: selectedSnapshot.path,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshotForWrite();
  const heartbeatSource = normalizeHeartbeatRepairSource(snapshot);
  const projectedHeartbeat = tryProjectRetiredHeartbeatConfig(heartbeatSource.sourceConfig);
  const heartbeatMigration =
    projectedHeartbeat && !isDeepStrictEqual(projectedHeartbeat, heartbeatSource.sourceConfig)
      ? {
          config: projectedHeartbeat,
          changes: heartbeatSource.changes,
          pendingStateMigration: true as const,
        }
      : undefined;
  const configRepair = await withArtifactPreservingStateReads(() =>
    planAutomaticConfigRepair(snapshot, heartbeatMigration),
  );
  // Stateful retirement remains with the automatic Doctor owner; include-only
  // repairs use the existing update-channel planner and its captured identities.
  const includePlan =
    !configRepair && !heartbeatMigration && snapshot.includedPaths?.length
      ? withArtifactPreservingStateReads(() =>
          planLegacyConfigForUpdateChannel(snapshot, writeOptions),
        )
      : undefined;
  const includeRepair = includePlan?.changes.length ? includePlan : undefined;
  const includeBoundary = includeRepair
    ? resolveConfigIncludeWriteBoundary({ snapshot, nextConfig: includeRepair.nextConfig })
    : null;
  const includeTarget =
    includeBoundary && writeOptions.includeFileTargetsForWrite?.[includeBoundary.includePath];
  if (snapshot.exists && !snapshot.valid && !configRepair && !includeRepair) {
    return {
      status: "refused",
      reason: `The config is invalid (${snapshot.issues
        .slice(0, 3)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}). Run openclaw config validate before retrying the update.`,
    };
  }
  const config = configRepair?.config ?? includeRepair?.config ?? snapshot.config;
  const selection = await resolveDatabaseEngineSelection(config, env);
  return withDatabaseEngineSelection(selection, async (): Promise<StateUpgradeResult> => {
    const inventory = await discoverDatabases(stateDir, config, env);
    const outdated = outdatedDatabases(inventory.targets);
    const protectedTargets = floorRaisingDatabases(inventory.targets);
    let restore: StateUpgradeRestore | undefined;
    try {
      restore = await beginStateUpgradeRestore(env);
      const legacySources = await hasLegacyStateSources(stateDir, config, env, inventory.targets);
      // Additive-only schema work has no historical content repair to run.
      // Reader-floor upgrades retain the full Doctor detector after convergence.
      if (outdated.length === 0 && !configRepair && !includeRepair && !legacySources) {
        (await publishStateUpgradeRestore(restore, { targets: [], config }))?.();
        return { status: "current" };
      }
      if (process.platform === "linux" && (configRepair || includeRepair)) {
        const rootTarget = fs.realpathSync(snapshot.path);
        if (
          fs
            .readFileSync("/proc/self/mountinfo", "utf8")
            .split("\n")
            .some((line) => {
              const mounted = decodeMountInfoPath(line.split(" ")[4] ?? "");
              return mounted === rootTarget || mounted === includeTarget;
            })
        ) {
          return {
            status: "refused",
            reason:
              "Changed config is a single-file mount and cannot be safely restored. Run openclaw doctor --fix before retrying the update. Nothing live was changed.",
          };
        }
      }
      if (restore) {
        if (includeTarget && !isUpgradeRestorePath(stateDir, includeTarget)) {
          return {
            status: "refused",
            reason: `The release trial cannot restore changed included config ${includeTarget}. Run openclaw doctor --fix before retrying the update. Nothing live was changed.`,
          };
        }
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
      const completeRestore = await publishStateUpgradeRestore(restore, {
        targets: [
          ...protectedTargets,
          ...(configRepair || includeRepair
            ? [{ path: snapshot.path, engine: "file" as const }]
            : []),
          ...(includeTarget ? [{ path: includeTarget, engine: "file" as const }] : []),
        ],
        config,
      });
      const migrationResult = await runWithDoctorMigrationBackup(
        captureFreshDoctorMigrationTables,
        async (): Promise<StateUpgradeResult> => {
          for (const file of restore?.existing?.files ?? []) {
            if (file.preimage !== null) {
              recordDoctorMigrationFullBackup(file.live, { path: file.preimage });
            }
          }
          // Outside a launcher trial, the same Doctor owner backs up this one
          // credential-bearing database before the cutover can retire its rows.
          const credentialMigrations = outdated.filter(
            (target) =>
              target.kind === "state" &&
              target.engine === "sqlite" &&
              target.version < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
          );
          if (!restore && credentialMigrations.length > 0) {
            const paths = credentialMigrations.map((target) => target.path);
            const backup = await backupDoctorMigrationDatabases({
              env,
              databasePaths: paths,
              pendingDatabasePaths: paths,
              pendingMigrations: credentialMigrations.map((target) => ({
                kind: target.kind,
                path: target.path,
                foundVersion: target.version,
                supportedVersion: expectedVersion(target),
              })),
            });
            logStateMigrationResult(backup, log);
            if (backup.warnings.length > 0) {
              throw new Error(backup.warnings.join("\n"));
            }
          }
          try {
            for (const target of outdated.filter((entry) => entry.kind === "state")) {
              if (target.engine === "sqlite") {
                const prepared = await prepareOpenClawStateDatabaseSchema(
                  { path: target.path, env },
                  "doctor-preparation",
                );
                logStateMigrationResult(prepared, log);
                if (prepared.warnings.length > 0) {
                  throw new Error(prepared.warnings.join("\n"));
                }
              }
              await openOpenClawStateDatabaseForDoctor({
                path: target.path,
                env,
                ...(target.version < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION
                  ? { clientCredentialMigrationFromVersion: target.version }
                  : {}),
              });
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
                      const engine = openAgentEngineStore(
                        database,
                        target.agentId!,
                        target.path,
                        true,
                      );
                      if (engine !== database) {
                        engine.close();
                      }
                    } else {
                      runSqliteIntegrityOperationSync(
                        ensureOpenClawAgentDatabaseSchemaSteps(database, {
                          agentId: target.agentId!,
                          path: target.path,
                          env,
                          register: true,
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
            if (protectedTargets.length > 0 || configRepair || includeRepair || legacySources) {
              const legacySessionSurfaces = await prepareLegacySessionSurfaces({ config, env });
              const legacyState = await detectLegacyStateMigrations({
                cfg: config,
                env,
                doctorOnlyStateMigrations: true,
                legacySessionSurfaces,
              });
              const legacyWork = hasRealLegacyWork(legacyState, env, inventory.targets);
              if (outdated.length === 0 && !configRepair && !includeRepair && !legacyWork) {
                return { status: "current" };
              }
              // File imports retain their existing Doctor owner, not a subprocess or copy.
              if (legacyWork) {
                const legacy = await autoMigrateLegacyState({
                  cfg: config,
                  env,
                  doctorOnlyStateMigrations: true,
                  configIncludedPaths: snapshot.includedPaths,
                  legacySessionSurfaces,
                });
                logStateMigrationResult(legacy, log);
                throwIfDoctorStateMigrationRefused(legacy.stepReceipts);
                const { noteSessionTranscriptHealth } =
                  await import("../commands/doctor-session-transcripts.js");
                await noteSessionTranscriptHealth({
                  cfg: config,
                  env,
                  shouldRepair: true,
                  ...(legacy.postSessionPluginMigration
                    ? { postSessionPluginMigration: legacy.postSessionPluginMigration }
                    : {}),
                  postSessionPluginMigrationPlanBound: true,
                  onStepReceipt: (receipt) => throwIfDoctorStateMigrationRefused([receipt]),
                  onWarnings: (warnings) => {
                    for (const warning of warnings) {
                      log.warn(warning);
                    }
                  },
                });
              }
            }
            if (configRepair) {
              await commitAutomaticConfigRepair(
                configRepair,
                snapshot,
                heartbeatMigration
                  ? async (current) => {
                      const source = normalizeHeartbeatRepairSource(current);
                      const retired = await retireHeartbeatWithDoctor(
                        source.sourceConfig,
                        env,
                        (warnings) => log.warn(warnings.join("\n")),
                      );
                      if (!isDeepStrictEqual(retired, heartbeatMigration.config)) {
                        throw new Error(
                          "Heartbeat migration changed after validation; config was retained.",
                        );
                      }
                    }
                  : undefined,
              );
            }
            if (includeRepair) {
              const repaired = await repairLegacyConfigForUpdateChannel({
                configSnapshot: snapshot,
                plan: includeRepair,
                jsonMode: true,
              });
              if (repaired.warnings?.length) {
                log.warn(repaired.warnings.join("\n"));
              }
            }
          } finally {
            await closeOpenClawStateDatabaseAsync();
          }
          if (restore) {
            await pruneGenerations(
              stateDir,
              restore.generation,
              readPinnedVersions(path.join(stateDir, "state", "openclaw.sqlite")),
              new Set(
                restore.existing?.files
                  .filter((file) => file.preimage !== null)
                  .map((file) => file.live),
              ),
              {
                config,
                activeAnchors: inventory.targets.map((target) => target.path),
                warn: log.warn,
              },
            );
          }
          return { status: "upgraded" };
        },
      );
      completeRestore?.();
      return migrationResult;
    } catch (error) {
      return { status: "refused", reason: formatErrorMessage(error) };
    }
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

/** Fresh auth ownership is Doctor bootstrap, not a legacy payload to import at boot. */
function hasRealLegacyWork(
  detected: LegacyStateDetection,
  env: NodeJS.ProcessEnv,
  targets: readonly DatabaseTarget[],
): boolean {
  for (const [kind, source] of Object.entries(detected)) {
    if (
      kind !== "sharedAuthStore" &&
      (kind !== "stateSchema" ||
        targets.some((target) => target.kind === "state" && target.version > 0)) &&
      source !== null &&
      typeof source === "object" &&
      "hasLegacy" in source &&
      source.hasLegacy
    ) {
      return true;
    }
  }
  if (detected.worktrees.pathRewrites.length > 0 || detected.deviceIdentity.hasInvalidCanonical) {
    return true;
  }
  const auth = detected.sharedAuthStore;
  if (!auth.hasLegacy) {
    return false;
  }
  if (auth.held || auth.conflictingSourcePath) {
    return true;
  }
  const file = inspectSharedAuthLegacySourceFile(auth.sourcePath);
  return (
    (file.status === "present" && file.size > 0) ||
    hasPendingSharedAuthCleanup(env, auth.sourcePath, { artifactPreservingReadOnly: true })
  );
}
