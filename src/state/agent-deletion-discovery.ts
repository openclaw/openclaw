import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDatabaseDeletionSnapshot } from "./agent-deletion-journal.read.js";
import type {
  AgentDatabaseDeletionSnapshot,
  AgentDeletionJournalDisposition,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type Target = { agentId: string; path: string };
type RetainedAgentDatabaseNamespace =
  | "database"
  | {
      kind: "agent-directory" | "legacy-database";
      readDatabasePaths: () => readonly string[];
    };

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
  const artifactDirectories = params.artifactDirectories;
  const journal = params.retainedDeletions;
  const known =
    journal.status === "present"
      ? journal
      : journal.status === "unavailable"
        ? journal.known
        : undefined;
  const entries = known?.entries ?? [];
  const unknown = journal.status === "unavailable" ? "unavailable" : undefined;
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const recorded = artifactDirectories ?? [
    ...params.configuredAgentDatabaseTargets,
    ...params.registeredAgentDatabases,
  ];
  const heldPaths = !known
    ? []
    : artifactDirectories
      ? known.held.flatMap((entry) => {
          const defaultDirectory = path.dirname(
            resolveOpenClawAgentSqlitePath({ agentId: entry.agentId, env: params.env }),
          );
          const recordedDirectory = path.dirname(entry.path);
          const canonicalAgentFile = path.basename(entry.path) === "openclaw-agent.sqlite";
          const directories = [
            { agentId: entry.agentId, path: defaultDirectory },
            ...artifactDirectories.filter(
              (directory) =>
                normalizeAgentId(directory.agentId) === entry.agentId ||
                (canonicalAgentFile && samePath(directory.path, recordedDirectory)),
            ),
          ];
          // Only directory bindings or the canonical agents tree identify adjacent artifacts.
          const selectedByEnvironment =
            canonicalAgentFile &&
            [params.env.OPENCLAW_AGENT_DIR, params.env.PI_CODING_AGENT_DIR].some(
              (directory) =>
                directory?.trim() &&
                samePath(resolveUserPath(directory, params.env), recordedDirectory),
            );
          if (
            selectedByEnvironment ||
            (canonicalAgentFile &&
              path.basename(recordedDirectory) === "agent" &&
              samePath(
                path.dirname(path.dirname(recordedDirectory)),
                path.dirname(path.dirname(defaultDirectory)),
              ))
          ) {
            directories.push({ agentId: entry.agentId, path: recordedDirectory });
          }
          return directories;
        })
      : known.held;
  return (pathname: string, agentId?: string) => {
    let logicalTargets: readonly Target[] = [];
    if (!artifactDirectories && agentId !== undefined) {
      const ownerId = normalizeAgentId(agentId);
      logicalTargets = params.configuredAgentDatabaseTargets.filter(
        (target) => normalizeAgentId(target.agentId) === ownerId,
      );
      if (logicalTargets.length === 0) {
        logicalTargets = [
          ...params.registeredAgentDatabases.filter(
            (target) => normalizeAgentId(target.agentId) === ownerId,
          ),
          {
            agentId: ownerId,
            path: resolveUnsuffixedSqliteTargetFromSessionStorePath(pathname).path,
          },
        ];
      }
    }
    if (
      heldPaths.some(
        (entry) =>
          (artifactDirectories && entry.agentId === agentId) ||
          samePath(entry.path, pathname) ||
          logicalTargets.some((target) => samePath(target.path, entry.path)),
      )
    ) {
      return "held";
    }
    const deletion = entries.find(
      (entry) =>
        entry.agentId === agentId ||
        (artifactDirectories ? [entry.agentDir] : entry.databasePaths).some((file) =>
          samePath(file, pathname),
        ),
    );
    if (!deletion) {
      return unknown;
    }
    const surviving = recorded.some(
      (target) =>
        !entries.some((entry) => entry.agentId === normalizeAgentId(target.agentId)) &&
        samePath(target.path, pathname) &&
        (artifactDirectories !== undefined ||
          (isPersistentOpenClawAgentDatabasePath(target.path, params.env) &&
            (params.configuredAgentDatabaseTargets.includes(target) ||
              isPathInside(
                fs.realpathSync.native(resolveStateDir(params.env)),
                fs.realpathSync.native(target.path),
              )))),
    );
    return agentId === deletion.agentId || !surviving ? deletion : unknown;
  };
}

export function createRetainedAgentDatabaseMatcher(
  env: NodeJS.ProcessEnv,
  readConfiguredTargets: () => readonly Target[],
  namespace: RetainedAgentDatabaseNamespace = "database",
  purpose: AgentDeletionJournalPurpose = "maintenance",
) {
  return createRetainedAgentDatabaseMatcherFromSnapshot(
    env,
    readConfiguredTargets,
    readAgentDatabaseDeletionSnapshot(env, purpose),
    namespace,
    purpose,
  );
}

export function createRetainedAgentDatabaseMatcherFromSnapshot(
  env: NodeJS.ProcessEnv,
  readConfiguredTargets: () => readonly Target[],
  snapshot: AgentDatabaseDeletionSnapshot | undefined,
  namespace: RetainedAgentDatabaseNamespace = "database",
  purpose: AgentDeletionJournalPurpose = "maintenance",
) {
  const agentDirectories = namespace !== "database" && namespace.kind === "agent-directory";
  if (!snapshot && namespace !== "database" && purpose === "maintenance") {
    // Legacy inputs can predate SQLite; any surviving family still has unknown history.
    const unavailable =
      [resolveOpenClawStateSqlitePath(env), ...namespace.readDatabasePaths()].some(
        hasSqliteFileFamily,
      ) ||
      (agentDirectories &&
        readConfiguredTargets().some((target) => hasSqliteArtifacts(target.path)));
    return (pathname: string, _agentId?: string) =>
      unavailable || (agentDirectories && hasSqliteArtifacts(pathname)) ? "unavailable" : undefined;
  }
  const retainedDeletions = snapshot?.retainedDeletions;
  if (
    !retainedDeletions ||
    (retainedDeletions.status !== "present" &&
      !(retainedDeletions.status === "unavailable" && retainedDeletions.known))
  ) {
    return (_pathname: string, _agentId?: string) =>
      purpose === "maintenance" &&
      (!retainedDeletions || retainedDeletions.status === "unavailable")
        ? "unavailable"
        : undefined;
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
