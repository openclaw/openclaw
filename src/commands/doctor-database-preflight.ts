import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { hasErrnoCode } from "../infra/errno.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { isUpdateRehearsalReadOnlyPath } from "../infra/update-rehearsal-paths.js";
import { shellEscape } from "../shared/shell-quote.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import { resolveRelativeSessionStoreMigrationTargets } from "./doctor-relative-session-store-paths.js";

export type DoctorDatabasePreflight = OpenClawDatabaseSchemaPreflight & {
  /** The native updater already captured these files while holding stopped-state custody. */
  verifiedSnapshots?: readonly BackupSqliteSnapshotFact[];
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
  agentDatabaseRecoveryConfigValid?: boolean;
  updateSchemaRehearsal?: { runId: string; updaterVersion: string };
};

/** Diagnose failed storage admission by effective access, never file ownership. */
export function diagnoseDoctorStateStorageFailure(error: unknown): Error | undefined {
  const isPermissionFailure = (cause: unknown) =>
    ["EACCES", "EPERM", "EROFS"].some((code) => hasErrnoCode(cause, code));
  if (
    !collectNestedErrorCandidates(error).some(
      (cause) =>
        cause instanceof DoctorUnreadableStateDatabaseError ||
        extractErrorCode(cause) === "OPENCLAW_STATE_LEASE_STORAGE_FAILED" ||
        classifyGatewayStorageFailure(cause) === "SQLITE_READONLY" ||
        isPermissionFailure(cause),
    )
  ) {
    return undefined;
  }
  const databasePath = resolveOpenClawStateSqlitePath();
  let target = databasePath;
  try {
    for (target of resolveSqliteDatabaseFilePaths(databasePath)) {
      try {
        // Opening without truncation also catches immutable files that pass access(W_OK).
        fs.closeSync(fs.openSync(target, "r+"));
      } catch (cause) {
        if (!hasErrnoCode(cause, "ENOENT")) {
          throw cause;
        }
      }
    }
    target = path.dirname(databasePath);
    const probe = path.join(target, `.openclaw-write-probe-${randomUUID()}`);
    const descriptor = fs.openSync(probe, "wx", 0o600);
    try {
      fs.closeSync(descriptor);
    } finally {
      fs.unlinkSync(probe);
    }
  } catch (cause) {
    if (isPermissionFailure(cause)) {
      const quotedTarget = shellEscape(target);
      return new Error(
        `State storage is not writable at ${target} (database: ${databasePath}). Fix ownership and permissions for the user running OpenClaw (for example: sudo chown "$(id -u):$(id -g)" ${quotedTarget}); the database and sidecars need read/write access and parent directories need write/search access. Or remount the volume writable. If the file or directory is immutable, clear its immutable flag (on macOS: chflags nouchg ${quotedTarget}). Then rerun openclaw doctor. For read-only diagnostics, use openclaw doctor --lint.`,
        { cause: error },
      );
    }
  }
  return undefined;
}

/** Prepare fleet facts through the artifact-preserving schema readers. */
export async function prepareDoctorDatabasePreflight(
  options: {
    scope?: "state";
    cfg?: OpenClawConfig;
    /**
     * Update Doctor compares database generations recorded at snapshot capture. A native
     * open of an idle WAL family rebuilds its WAL index and changes that generation, so
     * those runs read every source through private snapshots instead.
     */
    preserveSourceArtifacts?: true;
  } = {},
): Promise<DoctorDatabasePreflight> {
  // Delegated update Doctor enters without CLI boot's process-wide engine selection.
  if (!getDatabaseEngineSelection()) {
    const { readConfigSnapshotForEngineSelection } = await import("./config-preflight-snapshot.js");
    await readConfigSnapshotForEngineSelection();
  }
  const { scope, preserveSourceArtifacts } = options;
  const databasePreflight = await import("../state/openclaw-database-preflight.js");
  const [
    { createConfigIO },
    targets,
    { listAgentIds, resolveAgentDir },
    { openDoctorStateSchemaReadAdmission },
  ] = await Promise.all([
    import("../config/io.js"),
    import("../config/sessions/targets.js"),
    import("../agents/agent-scope-config.js"),
    import("../state/openclaw-state-db-doctor-schema.js"),
  ]);
  const snapshot =
    scope === "state" || options.cfg
      ? undefined
      : await createConfigIO({
          env: { ...process.env },
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
  const cfg =
    scope === "state" ? undefined : (options.cfg ?? snapshot?.sourceConfig ?? snapshot?.config);
  let agentDatabaseMigrationDiscovery: PreparedAgentDatabaseMigrationDiscovery | undefined;
  const databaseSchemas = await databasePreflight.preflightOpenClawDatabaseSchemas({
    env: process.env,
    scope,
    openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    preserveSourceArtifacts,
    ...(cfg
      ? {
          // Custom stores go through the artifact-preserving header reader; discovery
          // must not open live SQLite files before the update guard.
          configuredAgentDatabaseTargets: (registered) => [
            ...listAgentIds(cfg).map((agentId) => ({
              agentId,
              path: path.join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"),
            })),
            ...resolveRelativeSessionStoreMigrationTargets(cfg, process.env, registered).filter(
              (target) => !isUpdateRehearsalReadOnlyPath(target.path, process.env),
            ),
          ],
          configuredAgentDatabaseCandidatePaths:
            targets.resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env: process.env }),
          agentAdmissionConfig: cfg,
          onAgentDatabaseDiscovery: (prepared: PreparedAgentDatabaseMigrationDiscovery) => {
            agentDatabaseMigrationDiscovery = prepared;
          },
        }
      : {}),
  });
  if (databaseSchemas.incompatible.length > 0) {
    throw new databasePreflight.OpenClawDatabaseSchemaPreflightError(databaseSchemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadableStateDatabase = databaseSchemas.indeterminate.find(
    (database) => database.kind === "state",
  );
  if (unreadableStateDatabase) {
    throw new DoctorUnreadableStateDatabaseError(
      unreadableStateDatabase.path,
      unreadableStateDatabase.reason,
    );
  }
  return {
    ...databaseSchemas,
    ...(agentDatabaseMigrationDiscovery
      ? {
          agentDatabaseMigrationDiscovery,
          // Supplied configs do not validate a captured ownership inventory.
          agentDatabaseRecoveryConfigValid: snapshot?.valid === true,
        }
      : {}),
  };
}
