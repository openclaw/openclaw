import fs from "node:fs/promises";
import path from "node:path";
import {
  listLegacyRegistryWorktreesForMigration,
  listRegistryWorktreesForMigration,
} from "../agents/worktrees/registry.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { hasErrnoCode } from "./errno.js";
import { migrationFileExists } from "./state-migrations.fs.js";
import {
  prepareAgentDatabaseMigrationDiscovery,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "./state-migrations.media-persistence-targets.js";
import type { LegacyStateDetection } from "./state-migrations.types.js";

export async function prepareDoctorAgentDatabaseDiscovery(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  artifactPreservingReadOnly = false,
): Promise<PreparedAgentDatabaseMigrationDiscovery> {
  const registeredAgentDatabases = await inspectOpenClawRegisteredAgentDatabases({
    env,
    includeIncompatibleSchemaVersions: true,
  });
  const prepare = () =>
    prepareAgentDatabaseMigrationDiscovery({
      env,
      registeredAgentDatabases,
      configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(cfg, {
        env,
        registeredDatabases: registeredAgentDatabases,
      }),
    });
  return artifactPreservingReadOnly ? withArtifactPreservingStateReads(prepare) : prepare();
}

export async function detectManagedWorktreeStateMigration(params: {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
  artifactPreservingReadOnly?: boolean;
}): Promise<LegacyStateDetection["worktrees"]> {
  const rawRoot = path.join(params.stateDir, "worktrees");
  const stateEnv = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const databaseExists = migrationFileExists(resolveOpenClawStateSqlitePath(stateEnv));
  const legacyIds =
    params.doctorOnlyStateMigrations === true && databaseExists
      ? listLegacyRegistryWorktreesForMigration(stateEnv, {
          artifactPreservingReadOnly: params.artifactPreservingReadOnly,
        }).map((worktree) => worktree.id)
      : [];
  const hasLegacy = legacyIds.length > 0;
  // Detection is read-only for the doctor --lint contract. ManagedWorktreeService.worktreesRoot()
  // owns directory creation; absent roots are canonicalized through their existing state parent.
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(rawRoot);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    try {
      canonicalRoot = path.join(await fs.realpath(params.stateDir), "worktrees");
    } catch (stateDirError) {
      if (hasErrnoCode(stateDirError, "ENOENT")) {
        return { hasLegacy, legacyIds, pathRewrites: [] };
      }
      throw stateDirError;
    }
  }
  if (rawRoot === canonicalRoot || !databaseExists) {
    return { hasLegacy, legacyIds, pathRewrites: [] };
  }
  const pathRewrites = listRegistryWorktreesForMigration(stateEnv, {
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  }).flatMap((row) => {
    const fromPath = path.join(rawRoot, row.repoFingerprint, row.name);
    return row.path === fromPath
      ? [
          {
            id: row.id,
            fromPath,
            toPath: path.join(canonicalRoot, row.repoFingerprint, row.name),
          },
        ]
      : [];
  });
  return { hasLegacy, legacyIds, pathRewrites };
}
