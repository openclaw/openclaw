import fs from "node:fs";
import { resolveStateDir } from "../config/paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readAgentDatabaseDeletionSnapshot,
  type AgentDeletionJournalDisposition,
} from "./agent-deletion-journal.read.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
} from "./openclaw-agent-db-registry.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type Target = { agentId: string; path: string };

function hasSqliteFileFamily(pathname: string): boolean {
  return resolveSqliteDatabaseFilePaths(pathname).some(
    (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined,
  );
}

function hasSqliteArtifacts(directory: string): boolean {
  try {
    return fs
      .readdirSync(directory)
      .some((name) => /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/iu.test(name));
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    // A dangling directory is unavailable, rather than an empty legacy layout.
    return fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined;
  }
}

/** Recorded surviving owners can share retained files; directory-name inference cannot. */
export function createAgentDatabaseDeletionClassifier(params: {
  env: NodeJS.ProcessEnv;
  retainedDeletions: AgentDeletionJournalDisposition;
  configuredAgentDatabaseTargets: readonly Target[];
  registeredAgentDatabases: readonly Target[];
  artifactDirectories?: readonly Target[];
}) {
  const entries = params.retainedDeletions;
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const recorded = params.artifactDirectories ?? [
    ...params.configuredAgentDatabaseTargets,
    ...params.registeredAgentDatabases,
  ];
  return (pathname: string, agentId?: string) => {
    if (entries === "unavailable") {
      return entries;
    }
    const deletion = entries.find(
      (entry) =>
        entry.agentId === agentId ||
        (params.artifactDirectories ? [entry.agentDir] : entry.databasePaths).some((file) =>
          samePath(file, pathname),
        ),
    );
    if (!deletion) {
      return undefined;
    }
    const surviving = recorded.some(
      (target) =>
        !entries.some((entry) => entry.agentId === normalizeAgentId(target.agentId)) &&
        samePath(target.path, pathname) &&
        (params.artifactDirectories !== undefined ||
          (isPersistentOpenClawAgentDatabasePath(target.path, params.env) &&
            (params.configuredAgentDatabaseTargets.includes(target) ||
              isPathInside(
                fs.realpathSync.native(resolveStateDir(params.env)),
                fs.realpathSync.native(target.path),
              )))),
    );
    return agentId === deletion.agentId || !surviving ? deletion : undefined;
  };
}

export function createRetainedAgentDatabaseMatcher(
  env: NodeJS.ProcessEnv,
  readConfiguredTargets: () => readonly Target[],
  namespace:
    | "database"
    | {
        kind: "agent-directory" | "legacy-database";
        readDatabasePaths: () => readonly string[];
      } = "database",
) {
  const snapshot = readAgentDatabaseDeletionSnapshot(env);
  const agentDirectories = namespace !== "database" && namespace.kind === "agent-directory";
  if (!snapshot && namespace !== "database") {
    // Legacy inputs can predate SQLite; any surviving family still has unknown history.
    const unavailable =
      [resolveOpenClawStateSqlitePath(env), ...namespace.readDatabasePaths()].some(
        hasSqliteFileFamily,
      ) ||
      (agentDirectories && readConfiguredTargets().some(({ path }) => hasSqliteArtifacts(path)));
    return (pathname: string, _agentId?: string) =>
      unavailable || (agentDirectories && hasSqliteArtifacts(pathname));
  }
  const retainedDeletions = snapshot?.retainedDeletions ?? "unavailable";
  if (retainedDeletions === "unavailable" || retainedDeletions.length === 0) {
    return (_pathname: string, _agentId?: string) => retainedDeletions === "unavailable";
  }
  const configured = readConfiguredTargets();
  return createAgentDatabaseDeletionClassifier({
    env,
    retainedDeletions,
    configuredAgentDatabaseTargets: configured,
    artifactDirectories: agentDirectories ? configured : undefined,
    registeredAgentDatabases: snapshot?.registeredAgentDatabases ?? [],
  });
}
