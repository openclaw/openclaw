import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probePathCaseInsensitiveSync,
  resolvePathPrefixSync,
  retainEntryForPublication,
} from "@openclaw/fs-safe/advanced";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveProfileStateDir } from "../cli/profile-utils.js";
import {
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery,
  listLegacyOAuthSidecarPaths,
} from "../commands/doctor-auth-legacy-paths.js";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { resolveLegacyStateDirs, resolveNewStateDir, resolveStateDir } from "../config/paths.js";
import { inspectPersistedInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-state.js";
import {
  legacyInstalledPluginIndexUnsupportedMessage,
  resolveLegacyInstalledPluginIndexStorePath,
} from "../plugins/installed-plugin-index-store-path.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveUserPath } from "./home-dir.js";
import { migrationFileExists } from "./state-migrations.fs.js";
import { listRetiredDeliveryQueueFiles } from "./state-migrations.retired-delivery-files.js";
import { assertNoRetiredStateFiles } from "./state-migrations.retired-files.js";
import type { MigrationLogger } from "./state-migrations.types.js";

let autoMigrateStateDirChecked = false;

export function resetAutoMigrateLegacyStateDirForTest() {
  autoMigrateStateDirChecked = false;
}

type StateDirMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function resolveProfileWorkspaceIdentity(workspace: string): string {
  try {
    // Config can own a workspace before it exists, including through dangling aliases.
    const resolved = resolvePathPrefixSync(workspace);
    const canonicalPath = path.join(resolved.existingPath, ...resolved.unresolvedSegments);
    if (
      resolved.unresolvedSegments.length > 0 &&
      probePathCaseInsensitiveSync(canonicalPath, { allowTemporaryProbe: false }) === true
    ) {
      return path.join(
        resolved.existingPath,
        ...resolved.unresolvedSegments.map((segment) =>
          segment.replace(/[A-Z]/g, (character) => character.toLowerCase()),
        ),
      );
    }
    return canonicalPath;
  } catch {
    return resolveIdentityPathViaExistingAncestorSync(workspace);
  }
}

function resolveConfiguredProfileWorkspace(params: {
  config?: OpenClawConfigWithLegacyRoster;
  source: string;
  target: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string | undefined {
  const agents = params.config?.agents;
  const workspaces = [
    agents?.defaults?.workspace,
    ...Object.values(agents?.entries ?? {}).map((entry) => entry.workspace),
    ...(agents?.list ?? []).map((entry) => entry.workspace),
  ].flatMap((workspace) =>
    workspace?.trim()
      ? [resolveProfileWorkspaceIdentity(resolveUserPath(workspace, params.env, params.homedir))]
      : [],
  );
  if (workspaces.length === 0) {
    return undefined;
  }
  return [params.source, params.target].find((workspace) =>
    workspaces.includes(resolveProfileWorkspaceIdentity(workspace)),
  );
}

export function resolveLegacyProfileWorkspaceMigrationPaths(params: {
  config?: OpenClawConfigWithLegacyRoster;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { source: string; target: string } | undefined {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (!profile || normalizeLowercaseStringOrEmpty(profile) === "default") {
    return undefined;
  }
  const paths = {
    source: path.join(resolveProfileStateDir("default", env, homedir), `workspace-${profile}`),
    target: path.join(resolveProfileStateDir(profile, env, homedir), "workspace"),
  };
  return resolveConfiguredProfileWorkspace({ ...params, ...paths }) ? undefined : paths;
}

export function resolvePendingLegacyProfileWorkspaceMigrationPaths(params: {
  config?: OpenClawConfigWithLegacyRoster;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { source: string; target: string } | undefined {
  const paths = resolveLegacyProfileWorkspaceMigrationPaths(params);
  // An occupied target remains pending owner work: execution refuses it, so the
  // read-only plan must retain both endpoints instead of silently omitting it.
  return paths && lstatIfPresent(paths.source) ? paths : undefined;
}

export function migrateLegacyProfileWorkspace(params: {
  config?: OpenClawConfigWithLegacyRoster;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { changes: string[]; warnings: string[]; notices?: string[] } {
  const paths = resolveLegacyProfileWorkspaceMigrationPaths({
    env: params.env,
    homedir: params.homedir,
  });
  if (!paths) {
    return { changes: [], warnings: [] };
  }

  try {
    const legacyDir = paths.source;
    const targetDir = paths.target;
    const legacyStat = lstatIfPresent(legacyDir);
    if (!legacyStat) {
      return { changes: [], warnings: [] };
    }
    const configured = resolveConfiguredProfileWorkspace({ ...params, ...paths });
    if (configured) {
      const other = configured === legacyDir ? targetDir : legacyDir;
      return {
        changes: [],
        warnings: [],
        ...(lstatIfPresent(other)
          ? {
              notices: [
                `Profile workspace: keeping configured workspace at ${configured}; existing workspace at ${other} was left unchanged.`,
              ],
            }
          : {}),
      };
    }
    if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
      return {
        changes: [],
        warnings: [
          `Profile workspace migration skipped: legacy path is not a directory (${legacyDir}).`,
        ],
      };
    }
    if (lstatIfPresent(targetDir)) {
      return {
        changes: [],
        warnings: [
          `Profile workspace migration skipped: target already exists (${targetDir}). Kept legacy workspace at ${legacyDir}; merge manually.`,
        ],
      };
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(legacyDir, targetDir);
    return { changes: [`Profile workspace: ${legacyDir} → ${targetDir}`], warnings: [] };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Profile workspace migration failed: ${String(error)}`],
    };
  }
}

/** Default relocation names remain useful for locating retained pre-migration evidence. */
export function resolveLegacyStateDirMigrationCandidates(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Array<{ source: string; target: string }> {
  const env = params.env ?? process.env;
  if (
    env.OPENCLAW_STATE_DIR?.trim() ||
    env.OPENCLAW_HOME?.trim() ||
    env.OPENCLAW_CONFIG_PATH?.trim()
  ) {
    return [];
  }
  const homedir = params.homedir ?? os.homedir;
  const target = resolveNewStateDir(homedir);
  return resolveLegacyStateDirs(homedir).map((source) => ({ source, target }));
}

export function resolvePendingLegacyStateDirMigrationPaths(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { source: string; target: string } | undefined {
  return resolveLegacyStateDirMigrationCandidates(params).find(
    ({ source, target }) => lstatIfPresent(source) && !lstatIfPresent(target),
  );
}

export function resolveLegacyStateConfigPath(stateDir: string): string {
  const canonical = path.join(stateDir, "openclaw.json");
  return fs.existsSync(canonical) ? canonical : path.join(stateDir, "clawdbot.json");
}

function renameLegacyPath(source: string, target: string, kind: "directory" | "file") {
  try {
    const parentPath = fs.realpathSync(path.dirname(source));
    const parent = { path: parentPath, identity: fs.statSync(parentPath, { bigint: true }) };
    const publication = retainEntryForPublication({
      source: {
        parent,
        basename: path.basename(source),
        expected: { ...fs.lstatSync(source, { bigint: true }), kind },
      },
      destination: { parent, basename: path.basename(target) },
      assertBeforeMutation: () => {},
    });
    const result = publication.publish();
    if (
      result.transition !== "committed" ||
      result.verification !== "verified" ||
      result.resources !== "closed" ||
      result.issues.length > 0
    ) {
      throw new AggregateError(
        result.issues.map((issue) => issue.cause),
        "Legacy rename did not complete cleanly.",
      );
    }
  } catch (cause) {
    throw new Error(
      `Could not complete legacy rename ${source} → ${target}; stop OpenClaw and inspect both paths before retrying Doctor.`,
      { cause },
    );
  }
}

type StateDirMigrationParams = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
};

/** Reserve the once-only migration while its caller transfers maintenance custody. */
export function prepareLegacyStateDirMigration(params: StateDirMigrationParams) {
  if (autoMigrateStateDirChecked) {
    return undefined;
  }
  const result = migrateLegacyStateDirRoot(params);
  autoMigrateStateDirChecked = true;
  return {
    stateDir: resolveStateDir(params.env ?? process.env, params.homedir ?? os.homedir),
    result,
  };
}

export async function autoMigrateLegacyStateDir(
  params: StateDirMigrationParams,
): Promise<StateDirMigrationResult> {
  const prepared = prepareLegacyStateDirMigration(params);
  return prepared ? prepared.result : { migrated: false, skipped: true, changes: [], warnings: [] };
}

function migrateLegacyStateDirRoot(params: StateDirMigrationParams): StateDirMigrationResult {
  const env = params.env ?? process.env;
  const paths = resolveLegacyStateDirMigrationCandidates(params).find(({ source }) =>
    lstatIfPresent(source),
  );
  const changes: string[] = [];
  const warnings: string[] = [];
  const result = () => ({ migrated: changes.length > 0, skipped: !paths, changes, warnings });
  if (!paths) {
    return result();
  }
  const { source, target } = paths;
  if (lstatIfPresent(target)) {
    warnings.push(
      `Both ${source} and ${target} exist; leave them unchanged and move the legacy data manually before rerunning Doctor.`,
    );
    return result();
  }
  if (!lstatIfPresent(source)?.isDirectory()) {
    warnings.push(
      `Legacy state path is not a directory: ${source}; move it manually before rerunning Doctor.`,
    );
    return result();
  }
  const configPath = resolveLegacyStateConfigPath(source);
  assertNoRetiredStateFiles("JSON delivery queues", listRetiredDeliveryQueueFiles(source));
  assertNoRetiredOAuthSidecarsBeforeConfigRecovery({ env, configPath });
  const { env: inspectionEnv } = readCurrentConfigForResolution({ env, configPath });
  assertNoRetiredStateFiles(
    "OAuth credential sidecars",
    listLegacyOAuthSidecarPaths(inspectionEnv, undefined, source),
  );
  const legacyIndexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir: source });
  const pluginInstallWarning = migrationFileExists(legacyIndexPath)
    ? legacyInstalledPluginIndexUnsupportedMessage(legacyIndexPath)
    : withArtifactPreservingStateReads(() =>
        inspectPersistedInstalledPluginIndexInstallRecordsSync({ stateDir: source }).status ===
        "invalid"
          ? `State dir migration skipped because persisted plugin install records in ${source} are invalid`
          : null,
      );
  if (pluginInstallWarning) {
    warnings.push(pluginInstallWarning);
    return result();
  }
  renameLegacyPath(source, target, "directory");
  clearPluginMetadataLifecycleCaches();
  changes.push(`State dir: ${source} → ${target}`);
  return result();
}

export function renameLegacyConfigFile(stateDir: string): string[] {
  const source = path.join(stateDir, "clawdbot.json");
  const target = path.join(stateDir, "openclaw.json");
  if (
    !lstatIfPresent(source) ||
    lstatIfPresent(target) ||
    lstatIfPresent(path.join(path.dirname(stateDir), ".clawdbot"))
  ) {
    return [];
  }
  renameLegacyPath(source, target, "file");
  return [`Config: ${source} → ${target}`];
}
