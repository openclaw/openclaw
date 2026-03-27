import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import {
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import { buildCleanupPlan, isPathWithin } from "./cleanup-utils.js";

export type MigrateAssetKind = "config" | "credentials" | "workspace" | "agents" | "state";

export const VALID_MIGRATE_ASSET_KINDS: readonly string[] = [
  "config",
  "credentials",
  "workspace",
  "agents",
  "state",
] as const;

export type MigrateComponent = "config" | "credentials" | "workspace" | "sessions";

export const ALL_MIGRATE_COMPONENTS: readonly MigrateComponent[] = [
  "config",
  "credentials",
  "workspace",
  "sessions",
] as const;

export type MigrateAsset = {
  kind: MigrateAssetKind;
  sourcePath: string;
  displayPath: string;
  archivePath: string;
  /** For agent-scoped assets, the agent id. */
  agentId?: string;
};

export type SkippedMigrateAsset = {
  kind: MigrateAssetKind;
  sourcePath: string;
  displayPath: string;
  reason: "missing" | "covered" | "excluded";
};

export type MigratePlan = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  included: MigrateAsset[];
  skipped: SkippedMigrateAsset[];
};

export type MigrateManifest = {
  schemaVersion: 1;
  kind: "migrate";
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  components: MigrateComponent[];
  agents: string[];
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: Array<{
    kind: MigrateAssetKind;
    sourcePath: string;
    archivePath: string;
    agentId?: string;
  }>;
  skipped: Array<{
    kind: string;
    sourcePath: string;
    reason: string;
  }>;
};

export function buildMigrateArchiveRoot(nowMs = Date.now()): string {
  return `${formatSessionArchiveTimestamp(nowMs)}-openclaw-migrate`;
}

export function buildMigrateArchiveBasename(nowMs = Date.now()): string {
  return `${buildMigrateArchiveRoot(nowMs)}.tar.gz`;
}

function encodeAbsolutePathForArchive(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1]?.toUpperCase() ?? "UNKNOWN";
    const rest = windowsMatch[2] ?? "";
    return path.posix.join("windows", drive, rest);
  }
  if (normalized.startsWith("/")) {
    return path.posix.join("posix", normalized.slice(1));
  }
  return path.posix.join("relative", normalized);
}

export function buildMigrateArchivePath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForArchive(sourcePath));
}

async function canonicalizeExistingPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isComponentIncluded(
  component: MigrateComponent,
  components: readonly MigrateComponent[],
): boolean {
  return components.includes(component);
}

async function discoverAgentIds(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Resolve workspace directories scoped to specific agent IDs by looking up
 * their workspace config from agents.list[].
 */
function resolveAgentScopedWorkspaceDirs(
  cfg: OpenClawConfig,
  agentIds: readonly string[],
): string[] {
  const dirs = new Set<string>();
  const agentIdSet = new Set(agentIds);

  // Resolve the inherited default workspace (agents.defaults.workspace or system default).
  const defaultWorkspace =
    typeof cfg.agents?.defaults?.workspace === "string" && cfg.agents.defaults.workspace.trim()
      ? resolveUserPath(cfg.agents.defaults.workspace)
      : resolveDefaultAgentWorkspaceDir();

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const configuredAgentIds = new Set<string>();
  const agentsWithExplicitWorkspace = new Set<string>();
  for (const agent of list) {
    const agentRecord = agent as { id?: string; workspace?: string };
    if (typeof agentRecord.id !== "string") {
      continue;
    }
    if (!agentIdSet.has(agentRecord.id)) {
      continue;
    }
    configuredAgentIds.add(agentRecord.id);
    if (typeof agentRecord.workspace === "string" && agentRecord.workspace.trim()) {
      dirs.add(resolveUserPath(agentRecord.workspace));
      agentsWithExplicitWorkspace.add(agentRecord.id);
    }
  }

  // Include the inherited default workspace if any requested agent either:
  // - is in agents.list but has no explicit workspace (inherits the default), or
  // - is not in agents.list at all (exists on disk only, uses the default).
  const allHaveExplicitWorkspace = agentIds.every((id) => agentsWithExplicitWorkspace.has(id));
  if (!allHaveExplicitWorkspace) {
    dirs.add(defaultWorkspace);
  }

  return [...dirs];
}

export async function resolveMigratePlanFromDisk(params: {
  components?: readonly MigrateComponent[];
  agents?: readonly string[];
  nowMs?: number;
}): Promise<MigratePlan> {
  const components = params.components ?? ALL_MIGRATE_COMPONENTS;
  // Canonicalize path roots so they share a consistent prefix with the
  // canonicalized asset sourcePaths recorded later. Without this, a
  // symlinked state dir would cause import remapping to fall through.
  const stateDir = await canonicalizeExistingPath(resolveStateDir());
  const configPath = await canonicalizeExistingPath(resolveConfigPath());
  const oauthDir = await canonicalizeExistingPath(resolveOAuthDir());
  const archiveRoot = buildMigrateArchiveRoot(params.nowMs);

  const configSnapshot = await readConfigFileSnapshot();
  const cleanupPlan = buildCleanupPlan({
    cfg: configSnapshot.config,
    stateDir,
    configPath,
    oauthDir,
  });

  const includeWorkspace = isComponentIncluded("workspace", components);
  let workspaceDirs = includeWorkspace ? cleanupPlan.workspaceDirs : [];

  // When --agents is specified, filter workspace dirs to only include those
  // belonging to the requested agents. Always scope when --agents is set,
  // even if config is missing — fall back to default workspace only.
  if (includeWorkspace && params.agents && params.agents.length > 0) {
    if (configSnapshot.config) {
      workspaceDirs = resolveAgentScopedWorkspaceDirs(configSnapshot.config, params.agents);
    } else {
      // No config available — include only the system default workspace
      // since we can't determine per-agent workspace assignments.
      workspaceDirs = [resolveDefaultAgentWorkspaceDir()];
    }
  }

  const included: MigrateAsset[] = [];
  const skipped: SkippedMigrateAsset[] = [];

  // Config
  if (isComponentIncluded("config", components)) {
    const resolvedConfigPath = path.resolve(configPath);
    if (await pathExists(resolvedConfigPath)) {
      const canonical = await canonicalizeExistingPath(resolvedConfigPath);
      included.push({
        kind: "config",
        sourcePath: canonical,
        displayPath: shortenHomePath(canonical),
        archivePath: buildMigrateArchivePath(archiveRoot, canonical),
      });
    } else {
      skipped.push({
        kind: "config",
        sourcePath: resolvedConfigPath,
        displayPath: shortenHomePath(resolvedConfigPath),
        reason: "missing",
      });
    }
  }

  // Credentials
  if (isComponentIncluded("credentials", components)) {
    const resolvedOAuthDir = path.resolve(oauthDir);
    if (await pathExists(resolvedOAuthDir)) {
      const canonical = await canonicalizeExistingPath(resolvedOAuthDir);
      included.push({
        kind: "credentials",
        sourcePath: canonical,
        displayPath: shortenHomePath(canonical),
        archivePath: buildMigrateArchivePath(archiveRoot, canonical),
      });
    } else {
      skipped.push({
        kind: "credentials",
        sourcePath: resolvedOAuthDir,
        displayPath: shortenHomePath(resolvedOAuthDir),
        reason: "missing",
      });
    }
  }

  // Agent sessions and auth profiles
  if (isComponentIncluded("sessions", components)) {
    const allAgentIds = await discoverAgentIds(stateDir);
    const targetAgentIds =
      params.agents && params.agents.length > 0
        ? allAgentIds.filter((id) => params.agents!.includes(id))
        : allAgentIds;

    for (const agentId of targetAgentIds) {
      const agentDir = path.join(stateDir, "agents", agentId);
      if (await pathExists(agentDir)) {
        const canonical = await canonicalizeExistingPath(agentDir);
        included.push({
          kind: "agents",
          sourcePath: canonical,
          displayPath: shortenHomePath(canonical),
          archivePath: buildMigrateArchivePath(archiveRoot, canonical),
          agentId,
        });
      }
    }
  }

  // Workspaces
  if (includeWorkspace) {
    for (const workspaceDir of workspaceDirs) {
      const resolvedDir = path.resolve(workspaceDir);
      if (await pathExists(resolvedDir)) {
        const canonical = await canonicalizeExistingPath(resolvedDir);
        // Skip if already covered by another included asset.
        const coveredBy = included.find((asset) => isPathWithin(canonical, asset.sourcePath));
        if (coveredBy) {
          skipped.push({
            kind: "workspace",
            sourcePath: canonical,
            displayPath: shortenHomePath(canonical),
            reason: "covered",
          });
          continue;
        }
        included.push({
          kind: "workspace",
          sourcePath: canonical,
          displayPath: shortenHomePath(canonical),
          archivePath: buildMigrateArchivePath(archiveRoot, canonical),
        });
      } else {
        skipped.push({
          kind: "workspace",
          sourcePath: resolvedDir,
          displayPath: shortenHomePath(resolvedDir),
          reason: "missing",
        });
      }
    }
  }

  // Only include workspace dirs that were actually exported (not skipped as
  // missing/covered), so import remapping indexes match the real archive contents.
  const exportedWorkspaceDirs = included
    .filter((a) => a.kind === "workspace")
    .map((a) => a.sourcePath);

  return {
    stateDir,
    configPath,
    oauthDir,
    workspaceDirs: exportedWorkspaceDirs,
    included,
    skipped,
  };
}
