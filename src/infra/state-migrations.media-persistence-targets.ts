import fs from "node:fs";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../agents/session-dirs.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import {
  readAgentDatabaseDeletionSnapshot,
  type AgentDeletionJournalDisposition,
} from "../state/agent-deletion-journal.read.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { hasErrnoCode } from "./errno.js";
import { isPathInside } from "./path-guards.js";

export type AgentDatabaseMigrationTarget = {
  agentId: string;
  path: string;
  realPath: string;
  source: "configured" | "disk" | "registry";
};

type CandidateTarget = Omit<AgentDatabaseMigrationTarget, "realPath">;

export type PreparedAgentDatabaseMigrationDiscovery = {
  stateDir: string;
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  discovery: ReturnType<typeof discoverAgentDatabaseMigrationTargets>;
};

/** Discover maintenance targets without mutating the registry or creating stores. */
export function discoverAgentDatabaseMigrationTargets(params: {
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  retainedDeletions?: AgentDeletionJournalDisposition;
  env: NodeJS.ProcessEnv;
}) {
  const warnings: string[] = [];
  const externalWarnings: string[] = [];
  const retainedDeletions =
    params.retainedDeletions ??
    readAgentDatabaseDeletionSnapshot(params.env)?.retainedDeletions ??
    "unavailable";
  const classifyDeletion = createAgentDatabaseDeletionClassifier({ ...params, retainedDeletions });
  const failures: Array<{ path: string; reason: string }> = [];
  const registryRemovals: Array<{ agentId: string; path: string; change?: string }> = [];
  const sourceIdentities = new Map<string, { realPath?: string }>();
  const failure = (pathname: string, reason: string) => {
    warnings.push(reason);
    failures.push({ path: pathname, reason });
  };
  const discard = (candidate: CandidateTarget, change?: string) => {
    if (candidate.source === "registry" && retainedDeletions !== "unavailable") {
      registryRemovals.push({ agentId: candidate.agentId, path: candidate.path, change });
    }
  };
  // Configured and registered surviving owners precede retained and inferred paths.
  const candidates: CandidateTarget[] = [
    ...params.configuredAgentDatabaseTargets.map((target) => ({
      ...target,
      source: "configured" as const,
    })),
    ...params.registeredAgentDatabases.map((entry) => ({
      ...entry,
      source: "registry" as const,
    })),
    ...(retainedDeletions === "unavailable" ? [] : retainedDeletions).flatMap((entry) =>
      entry.databasePaths.map((pathname) => ({
        agentId: entry.agentId,
        path: pathname,
        source: "disk" as const,
      })),
    ),
  ];
  const activeStateDir = resolveStateDir(params.env);
  const agentsDir = path.join(activeStateDir, "agents");
  try {
    for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(agentsDir)) {
      const agentDir = path.dirname(sessionsDir);
      candidates.push({
        agentId: normalizeAgentId(path.basename(agentDir)),
        path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
        source: "disk",
      });
    }
  } catch (error) {
    failure(agentsDir, `Could not enumerate agent databases under ${agentsDir}: ${String(error)}`);
  }
  let activeStateDirRealPath: string | undefined;
  try {
    activeStateDirRealPath = fs.realpathSync.native(activeStateDir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      failure(
        activeStateDir,
        `Could not resolve active state directory ${activeStateDir}: ${String(error)}`,
      );
    }
  }
  const configuredPathMatcher = createOpenClawAgentDatabasePathMatcher();
  const targets: AgentDatabaseMigrationTarget[] = [];
  const seenPhysicalFiles = new Set<string>();
  for (const candidate of candidates) {
    // Preserve the original locator: lexical normalization of `link/../file`
    // can select a different file than filesystem symlink traversal does.
    const pathname = candidate.path;
    if (!isPersistentOpenClawAgentDatabasePath(pathname, params.env)) {
      discard(
        candidate,
        `Removed archived or transient agent database registry entry ${pathname}.`,
      );
      continue;
    }
    let realPath: string | undefined;
    try {
      realPath = fs.realpathSync.native(pathname);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        failure(pathname, `Could not resolve agent database ${pathname}: ${String(error)}`);
      }
    }
    sourceIdentities.set(pathname, { realPath });
    const deletion = classifyDeletion(pathname, candidate.agentId);
    const isConfiguredPath =
      realPath !== undefined &&
      params.configuredAgentDatabaseTargets.some((configuredTarget) => {
        if (normalizeAgentId(configuredTarget.agentId) !== normalizeAgentId(candidate.agentId)) {
          return false;
        }
        try {
          return configuredPathMatcher(pathname, configuredTarget.path);
        } catch {
          return false;
        }
      });
    const isInsideActiveStateDir = Boolean(
      realPath &&
      activeStateDirRealPath &&
      (realPath === activeStateDirRealPath || isPathInside(activeStateDirRealPath, realPath)),
    );
    if (realPath && !isInsideActiveStateDir && !isConfiguredPath && !deletion) {
      discard(candidate);
      const warning = `Skipped foreign agent database ${sanitizeForLog(pathname)}; it is outside the active state directory and is not a configured session store.`;
      warnings.push(warning);
      externalWarnings.push(warning);
      continue;
    }
    let stat: fs.BigIntStats | undefined;
    try {
      stat = fs.statSync(pathname, { bigint: true });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        failure(
          pathname,
          `Could not inspect ${candidate.source === "registry" ? "registered " : ""}agent database ${pathname}: ${String(error)}`,
        );
        continue;
      }
    }
    if (!stat?.isFile()) {
      discard(candidate, `Removed missing agent database registry entry ${pathname}.`);
      if (candidate.source === "registry") {
        warnings.push(`Skipped missing registered agent database ${pathname}.`);
      }
      continue;
    }
    if (!realPath) {
      discard(candidate);
      failure(
        pathname,
        `Skipped agent database ${pathname}; its filesystem boundary is unresolved.`,
      );
      continue;
    }
    const physicalFile = `${stat.dev}:${stat.ino}`;
    if (seenPhysicalFiles.has(physicalFile)) {
      continue;
    }
    if (deletion) {
      // A deleted alias must not claim a surviving owner's physical file.
      if (classifyDeletion(pathname)) {
        seenPhysicalFiles.add(physicalFile);
        warnings.push(
          `Held agent ${sanitizeForLog(deletion === "unavailable" ? candidate.agentId : deletion.agentId)} database ${sanitizeForLog(pathname)} (${deletion === "unavailable" ? "deletion journal unavailable" : "retained-by-deletion"}); run ${formatCliCommand("openclaw doctor --fix", params.env)} to inspect restoration.`,
        );
      }
      continue;
    }
    seenPhysicalFiles.add(physicalFile);
    targets.push({ ...candidate, path: pathname, realPath });
  }
  return {
    targets,
    retainedDeletions,
    registryRemovals,
    warnings,
    externalWarnings,
    failures,
    sourceIdentities,
  };
}

/** Migration alone owns cleanup of stale registry entries discovered above. */
export function resolveAgentDatabaseMigrationTargets(params: {
  changes: string[];
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
  preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
}): { targets: AgentDatabaseMigrationTarget[]; recoverableWarningCount: number } {
  const snapshot = readAgentDatabaseDeletionSnapshot(params.env);
  // Rediscover after schema repair and admission; initialization cannot replace unknown history.
  const retainedDeletions =
    params.preparedDiscovery?.stateDir === resolveStateDir(params.env) &&
    params.preparedDiscovery?.discovery.retainedDeletions === "unavailable"
      ? "unavailable"
      : (snapshot?.retainedDeletions ?? "unavailable");
  const discovery = discoverAgentDatabaseMigrationTargets({
    ...params,
    registeredAgentDatabases: snapshot?.registeredAgentDatabases ?? [],
    retainedDeletions,
  });
  for (const removed of discovery.registryRemovals) {
    unregisterOpenClawAgentDatabase({ ...removed, env: params.env });
    if (removed.change) {
      params.changes.push(removed.change);
    }
  }
  params.warnings.push(...discovery.warnings);
  // Deliberate registry omissions are reported without blocking authorized stores.
  // Failed discovery never grants that disposition, even if it also omitted a foreign entry.
  return {
    targets: discovery.targets,
    recoverableWarningCount: discovery.failures.length > 0 ? 0 : discovery.warnings.length,
  };
}

export function listTranscriptArchives(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.includes(".jsonl.") &&
        isSessionArchiveArtifactName(entry.name),
    )
    .map((entry) => path.join(directory, entry.name));
}
