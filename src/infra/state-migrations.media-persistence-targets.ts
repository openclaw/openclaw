import fs from "node:fs";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../agents/session-dirs.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import { listSqliteTargetCandidatePathsInDirectory } from "../config/sessions/session-sqlite-target-paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import {
  readAgentDatabaseDeletionSnapshot,
  type AgentDeletionJournalDisposition,
} from "../state/agent-deletion-journal.read.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
} from "../state/openclaw-agent-db.paths.js";
import { hasErrnoCode } from "./errno.js";
import { isPathInside } from "./path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export type AgentDatabaseMigrationTarget = {
  agentId: string;
  path: string;
  realPath: string;
  source: "configured" | "disk" | "registry" | "deletion";
};

type CandidateTarget = Omit<AgentDatabaseMigrationTarget, "realPath">;

export type PreparedAgentDatabaseMigrationDiscovery = {
  stateDir: string;
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  discovery: ReturnType<typeof discoverAgentDatabaseMigrationTargets>;
};

export function prepareAgentDatabaseMigrationDiscovery(params: {
  env: NodeJS.ProcessEnv;
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases?: readonly { agentId: string; path: string }[];
  deletionJournal?: AgentDeletionJournalDisposition;
  preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
}): PreparedAgentDatabaseMigrationDiscovery {
  const stateDir = resolveStateDir(params.env);
  const preparedJournal =
    params.preparedDiscovery?.stateDir === stateDir &&
    params.preparedDiscovery.discovery.deletionJournal.status === "unavailable"
      ? params.preparedDiscovery.discovery.deletionJournal
      : params.deletionJournal;
  const snapshot =
    params.registeredAgentDatabases && preparedJournal
      ? undefined
      : readAgentDatabaseDeletionSnapshot(params.env);
  const registeredAgentDatabases =
    params.registeredAgentDatabases ?? snapshot?.registeredAgentDatabases ?? [];
  const deletionJournal: AgentDeletionJournalDisposition = preparedJournal ??
    snapshot?.retainedDeletions ?? {
      status: "unavailable",
      cause: "missing",
      reason: "shared state database missing",
    };
  return {
    stateDir,
    configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets,
    registeredAgentDatabases,
    discovery: discoverAgentDatabaseMigrationTargets({
      ...params,
      registeredAgentDatabases,
      deletionJournal,
    }),
  };
}

/** Discover maintenance targets without mutating the registry or creating stores. */
export function discoverAgentDatabaseMigrationTargets(params: {
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  deletionJournal?: AgentDeletionJournalDisposition;
  env: NodeJS.ProcessEnv;
}) {
  const warnings: string[] = [];
  const externalWarnings: string[] = [];
  const deletionJournal: AgentDeletionJournalDisposition = params.deletionJournal ??
    readAgentDatabaseDeletionSnapshot(params.env)?.retainedDeletions ?? {
      status: "unavailable",
      cause: "missing",
      reason: "shared state database missing",
    };
  const knownDeletions =
    deletionJournal.status === "present"
      ? deletionJournal
      : deletionJournal.status === "unavailable"
        ? deletionJournal.known
        : undefined;
  const retainedDeletions = knownDeletions?.entries ?? [];
  const classifyDeletion = createAgentDatabaseDeletionClassifier({
    ...params,
    retainedDeletions: deletionJournal,
  });
  const failures: Array<{ path: string; reason: string }> = [];
  const registryRemovals: Array<{ agentId: string; path: string; change?: string }> = [];
  const sourceIdentities = new Map<string, { realPath?: string }>();
  const failure = (pathname: string, reason: string) => {
    warnings.push(reason);
    failures.push({ path: pathname, reason });
  };
  const discard = (candidate: CandidateTarget, change?: string) => {
    if (
      candidate.source === "registry" &&
      deletionJournal.status !== "unavailable" &&
      classifyDeletion(candidate.path) !== "held"
    ) {
      registryRemovals.push({ agentId: candidate.agentId, path: candidate.path, change });
    }
  };
  // Owner authority is explicit config, then the recorded registry fact, then
  // directory-name inference. Recorded identity must beat a stale directory basename.
  const candidates: CandidateTarget[] = [
    ...params.configuredAgentDatabaseTargets.map((target) => ({
      ...target,
      source: "configured" as const,
    })),
    ...params.registeredAgentDatabases.map((entry) => ({
      ...entry,
      source: "registry" as const,
    })),
    ...retainedDeletions.flatMap((entry) =>
      entry.databasePaths.map((pathname) => ({
        agentId: entry.agentId,
        path: pathname,
        source: "disk" as const,
      })),
    ),
    ...(knownDeletions?.held ?? []).map((target) => ({
      agentId: target.agentId,
      path: target.path,
      source: "deletion" as const,
    })),
  ];
  const activeStateDir = resolveStateDir(params.env);
  const agentsDir = path.join(activeStateDir, "agents");
  try {
    for (const sessionsDir of resolveAgentSessionDirsFromAgentsDirSync(agentsDir)) {
      const agentDir = path.dirname(sessionsDir);
      const databaseDir = path.join(agentDir, "agent");
      const paths = new Set([path.join(databaseDir, "openclaw-agent.sqlite")]);
      if (deletionJournal.status === "unavailable") {
        for (const candidate of listSqliteTargetCandidatePathsInDirectory(databaseDir)) {
          paths.add(candidate);
        }
      }
      for (const pathname of paths) {
        candidates.push({
          agentId: normalizeAgentId(path.basename(agentDir)),
          path: pathname,
          source: "disk",
        });
      }
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
  const retainedTargets: AgentDatabaseMigrationTarget[] = [];
  const unverifiedTargets: AgentDatabaseMigrationTarget[] = [];
  const seenTargets = new Set<string>();
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
      if (deletionJournal.status === "unavailable") {
        try {
          if (
            resolveSqliteDatabaseFilePaths(pathname).some((file) =>
              fs.lstatSync(file, { throwIfNoEntry: false }),
            )
          ) {
            failure(
              pathname,
              `Could not verify held database ${pathname}: SQLite family artifacts remain without a regular main database. Restore the matching main database before reconstructing deletion history.`,
            );
          }
        } catch (error) {
          failure(pathname, `Could not inspect held database family ${pathname}: ${String(error)}`);
        }
      }
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
    // Recovery holds retain every owner/locator; adjacent credentials belong to
    // their agent directory even when two locators share one physical database.
    const targetIdentity =
      typeof deletion === "string"
        ? JSON.stringify([normalizeAgentId(candidate.agentId), pathname])
        : `${stat.dev}:${stat.ino}`;
    if (seenTargets.has(targetIdentity)) {
      continue;
    }
    if (deletion) {
      // A deleted alias must not claim a surviving owner's physical file.
      if (classifyDeletion(pathname)) {
        seenTargets.add(targetIdentity);
        if (typeof deletion === "string") {
          unverifiedTargets.push({ ...candidate, realPath });
        } else {
          retainedTargets.push({ ...candidate, agentId: deletion.agentId, realPath });
        }
        warnings.push(
          `Held agent ${sanitizeForLog(typeof deletion === "string" ? candidate.agentId : deletion.agentId)} database ${sanitizeForLog(pathname)} (${typeof deletion === "string" ? (deletion === "held" ? "deletion journal reconstructed" : "deletion journal unavailable") : "retained-by-deletion"}); run ${formatCliCommand("openclaw doctor --fix", params.env)} to inspect restoration.`,
        );
      }
      continue;
    }
    seenTargets.add(targetIdentity);
    targets.push({ ...candidate, path: pathname, realPath });
  }
  if (unverifiedTargets.length > 0) {
    warnings.push(
      `Agent deletion journal ${deletionJournal.status === "unavailable" ? "missing" : "reconstructed"}; ${unverifiedTargets.length} store${unverifiedTargets.length === 1 ? "" : "s"} held back. Run ${formatCliCommand("openclaw doctor --fix", params.env)} to record recovery, then restore or delete each held agent explicitly.`,
    );
  }
  return {
    targets,
    retainedTargets,
    unverifiedTargets,
    deletionJournal,
    registryRemovals,
    warnings,
    externalWarnings,
    failures,
    sourceIdentities,
  };
}

/** Held-only inventories need no writer lease; their advisory must survive unavailable admission. */
export function agentDatabaseMigrationAdvisory(
  discovery: PreparedAgentDatabaseMigrationDiscovery["discovery"],
): MigrationMessages | undefined {
  if (
    discovery.deletionJournal.status !== "unavailable" &&
    (discovery.targets.length > 0 ||
      discovery.registryRemovals.length > 0 ||
      discovery.failures.length > 0)
  ) {
    return undefined;
  }
  return {
    changes: [],
    warnings: discovery.warnings,
    warningDisposition: "recoverable",
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
  const deletionJournal: AgentDeletionJournalDisposition =
    params.preparedDiscovery?.stateDir === resolveStateDir(params.env) &&
    params.preparedDiscovery.discovery.deletionJournal.status === "unavailable"
      ? params.preparedDiscovery.discovery.deletionJournal
      : (snapshot?.retainedDeletions ?? {
          status: "unavailable",
          cause: "missing",
          reason: "shared state database missing",
        });
  const discovery = discoverAgentDatabaseMigrationTargets({
    ...params,
    registeredAgentDatabases: snapshot?.registeredAgentDatabases ?? [],
    deletionJournal,
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
