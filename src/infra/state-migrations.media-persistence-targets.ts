import fs from "node:fs";
import path from "node:path";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../agents/session-dirs.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readRetainedAgentDeletions,
  retainedAgentDeletionHistoryAbsent,
  retainedAgentDeletionHistoryUnavailable,
  retainedAgentDeletionReadWarning,
  type RetainedAgentDeletionDisposition,
} from "../state/agent-deletion-journal.read.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { hasErrnoCode } from "./errno.js";
import { isPathInside } from "./path-guards.js";

type AgentDatabaseMigrationTarget = {
  agentId: string;
  path: string;
  realPath: string;
  source: "configured" | "disk" | "registry";
};

type CandidateTarget = Omit<AgentDatabaseMigrationTarget, "realPath">;

type RetainedAgentDatabaseHold = {
  kind: "notice" | "silent" | "warning";
  message: string;
};

export class RetainedAgentDatabaseHoldError extends Error {
  constructor(readonly hold: RetainedAgentDatabaseHold) {
    super(hold.message);
    this.name = "RetainedAgentDatabaseHoldError";
  }

  record(notices: string[], warnings: string[]): void {
    if (this.hold.kind === "silent") {
      return;
    }
    const messages = this.hold.kind === "notice" ? notices : warnings;
    if (!messages.includes(this.hold.message)) {
      messages.push(this.hold.message);
    }
  }
}

function classifyRetainedAgentDatabaseHold(params: {
  candidate: { agentId: string; path: string };
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  retainedDeletions: RetainedAgentDeletionDisposition;
  env: NodeJS.ProcessEnv;
}): RetainedAgentDatabaseHold | undefined {
  const pathMatcher = createOpenClawAgentDatabasePathMatcher();
  const sameDatabasePath = (left: string, right: string) => {
    try {
      return pathMatcher(left, right);
    } catch {
      return false;
    }
  };
  const hasConfiguredOwner = (deletedAgentIds: ReadonlySet<string>) =>
    params.configuredAgentDatabaseTargets.some(
      (owner) =>
        !deletedAgentIds.has(normalizeAgentId(owner.agentId)) &&
        sameDatabasePath(owner.path, params.candidate.path),
    );
  if (retainedAgentDeletionHistoryUnavailable(params.retainedDeletions)) {
    return {
      kind: "warning",
      message: `Skipped agent database ${params.candidate.path}; deletion journal history is unavailable.`,
    };
  }
  if (retainedAgentDeletionHistoryAbsent(params.retainedDeletions)) {
    return undefined;
  }
  const deletedAgentIds = new Set(
    params.retainedDeletions.map((entry) => normalizeAgentId(entry.agentId)),
  );
  const deletion = params.retainedDeletions.find(
    (entry) =>
      normalizeAgentId(entry.agentId) === normalizeAgentId(params.candidate.agentId) ||
      entry.databasePaths.some((databasePath) =>
        sameDatabasePath(databasePath, params.candidate.path),
      ),
  );
  if (!deletion) {
    return undefined;
  }
  const hasSurvivingRegisteredOwner = params.registeredAgentDatabases.some(
    (owner) =>
      !deletedAgentIds.has(normalizeAgentId(owner.agentId)) &&
      sameDatabasePath(owner.path, params.candidate.path),
  );
  if (hasConfiguredOwner(deletedAgentIds) || hasSurvivingRegisteredOwner) {
    return normalizeAgentId(params.candidate.agentId) === normalizeAgentId(deletion.agentId)
      ? { kind: "silent", message: "" }
      : undefined;
  }
  if (deletion.state === "pending") {
    return {
      kind: "notice",
      message: `Held database ${params.candidate.path} while deletion of agent ${deletion.agentId} is pending; finish or retry that agent deletion, then rerun ${formatCliCommand("openclaw doctor --fix", params.env)}.`,
    };
  }
  return {
    kind: "notice",
    message: `Held retained database ${params.candidate.path} for deleted agent ${deletion.agentId}; restore that agent from backup or move this database out of the active state directory, then rerun ${formatCliCommand("openclaw doctor --fix", params.env)}.`,
  };
}

export function assertRetainedAgentDatabaseWritable(params: {
  candidate: { agentId: string; path: string };
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
}): void {
  const retainedDeletions = readRetainedAgentDeletions(params.env);
  const readWarning = retainedAgentDeletionReadWarning(retainedDeletions);
  if (readWarning && !params.warnings.includes(readWarning)) {
    params.warnings.push(readWarning);
  }
  const hold = classifyRetainedAgentDatabaseHold({
    candidate: params.candidate,
    configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets,
    registeredAgentDatabases: listOpenClawRegisteredAgentDatabases({
      env: params.env,
      includeIncompatibleSchemaVersions: true,
    }),
    retainedDeletions,
    env: params.env,
  });
  if (hold) {
    throw new RetainedAgentDatabaseHoldError(hold);
  }
}

function listDefaultAgentDatabaseTargets(
  env: NodeJS.ProcessEnv,
  failure: (pathname: string, reason: string) => void,
): CandidateTarget[] {
  const agentsDir = path.join(resolveStateDir(env), "agents");
  try {
    return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).map((sessionsDir) => {
      const agentDir = path.dirname(sessionsDir);
      return {
        agentId: normalizeAgentId(path.basename(agentDir)),
        path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
        source: "disk" as const,
      };
    });
  } catch (error) {
    failure(agentsDir, `Could not enumerate agent databases under ${agentsDir}: ${String(error)}`);
    return [];
  }
}

/** Discover maintenance targets without mutating the registry or creating stores. */
export function discoverAgentDatabaseMigrationTargets(params: {
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  registeredAgentDatabases: readonly { agentId: string; path: string }[];
  retainedDeletions?: RetainedAgentDeletionDisposition;
  env: NodeJS.ProcessEnv;
}) {
  const warnings: string[] = [];
  const notices: string[] = [];
  const failures: Array<{ path: string; reason: string }> = [];
  const registryRemovals: Array<{ agentId: string; path: string; change?: string }> = [];
  const failure = (pathname: string, reason: string) => {
    warnings.push(reason);
    failures.push({ path: pathname, reason });
  };
  const discard = (candidate: CandidateTarget, change?: string) => {
    if (candidate.source === "registry") {
      registryRemovals.push({ agentId: candidate.agentId, path: candidate.path, change });
    }
  };
  // Owner authority is explicit config, then the recorded registry fact, then
  // directory-name inference. Recorded identity must beat a stale directory basename.
  const candidates: CandidateTarget[] = [
    ...params.configuredAgentDatabaseTargets.map((target) => ({
      agentId: target.agentId,
      path: target.path,
      source: "configured" as const,
    })),
    ...params.registeredAgentDatabases.map((entry) => ({
      agentId: entry.agentId,
      path: entry.path,
      source: "registry" as const,
    })),
    ...listDefaultAgentDatabaseTargets(params.env, failure),
  ];
  const activeStateDir = resolveStateDir(params.env);
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
  const retainedDeletions = params.retainedDeletions ?? readRetainedAgentDeletions(params.env);
  const retainedDeletionWarning = retainedAgentDeletionReadWarning(retainedDeletions);
  if (retainedDeletionWarning) {
    warnings.push(retainedDeletionWarning);
  }
  const targets: AgentDatabaseMigrationTarget[] = [];
  const seenRealPaths = new Set<string>();
  for (const candidate of candidates) {
    // Preserve the original locator: lexical normalization of `link/../file`
    // can select a different file than filesystem symlink traversal does.
    const pathname = candidate.path;
    const retainedHold = classifyRetainedAgentDatabaseHold({
      candidate,
      configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets,
      registeredAgentDatabases: params.registeredAgentDatabases,
      retainedDeletions,
      env: params.env,
    });
    if (retainedHold) {
      if (retainedHold.kind === "silent") {
        continue;
      }
      const messages = retainedHold.kind === "notice" ? notices : warnings;
      if (!messages.includes(retainedHold.message)) {
        messages.push(retainedHold.message);
      }
      if (retainedHold.kind === "warning") {
        failures.push({ path: pathname, reason: retainedHold.message });
      }
      continue;
    }
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
    if (realPath && !isInsideActiveStateDir && !isConfiguredPath) {
      discard(candidate);
      warnings.push(
        `Skipped foreign agent database ${pathname}; it is outside the active state directory and is not a configured session store.`,
      );
      continue;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(pathname);
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
      warnings.push(`Skipped agent database ${pathname}; its filesystem boundary is unresolved.`);
      continue;
    }
    if (seenRealPaths.has(realPath)) {
      continue;
    }
    // Claim identity only after every persistence, boundary, and file gate passed.
    seenRealPaths.add(realPath);
    targets.push({ ...candidate, path: pathname, realPath });
  }
  return { targets, registryRemovals, warnings, notices, failures };
}

/** Migration alone owns cleanup of stale registry entries discovered above. */
export function resolveAgentDatabaseMigrationTargets(params: {
  changes: string[];
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  env: NodeJS.ProcessEnv;
  notices?: string[];
  retainedDeletions?: RetainedAgentDeletionDisposition;
  warnings: string[];
}): AgentDatabaseMigrationTarget[] {
  let registeredAgentDatabases: ReturnType<typeof listOpenClawRegisteredAgentDatabases> = [];
  try {
    registeredAgentDatabases = listOpenClawRegisteredAgentDatabases({
      env: params.env,
      includeIncompatibleSchemaVersions: true,
    });
  } catch (error) {
    params.warnings.push(
      `Failed enumerating registered agent databases for state migration: ${String(error)}`,
    );
  }
  const discovery = discoverAgentDatabaseMigrationTargets({ ...params, registeredAgentDatabases });
  for (const removed of discovery.registryRemovals) {
    unregisterOpenClawAgentDatabase({ ...removed, env: params.env });
    if (removed.change) {
      params.changes.push(removed.change);
    }
  }
  params.warnings.push(...discovery.warnings);
  params.notices?.push(...discovery.notices);
  return discovery.targets;
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
