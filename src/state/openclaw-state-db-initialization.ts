import fs from "node:fs";
import path from "node:path";
import { readAgentStorePathsFromConfig } from "../config/agent-store-source.js";
import { listSqliteTargetCandidatePathsInDirectory } from "../config/sessions/session-sqlite-target-paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveQuarantineStorePath,
} from "./openclaw-state-db.paths.js";

export type StateDatabaseInitialization = { kind: "fresh" | "existing" | "unavailable" };

/** Capture deletion-history evidence before a native open can create the shared database. */
export function prepareStateDatabaseInitialization(
  pathname: string,
  env: NodeJS.ProcessEnv,
  initializationAgentPaths: readonly string[] = [],
): StateDatabaseInitialization {
  try {
    if (
      // Lease admission leaves a durable integrity store even for unconfigured external agents.
      [pathname, resolveQuarantineStorePath(env)].some((databasePath) =>
        resolveSqliteDatabaseFilePaths(databasePath).some((file) =>
          fs.lstatSync(file, { throwIfNoEntry: false }),
        ),
      )
    ) {
      return { kind: "existing" };
    }
    const stateDir = resolveOpenClawStateDirForDatabasePath(pathname);
    const candidates = new Set([
      ...initializationAgentPaths,
      ...readAgentStorePathsFromConfig(env, stateDir),
    ]);
    const agentsDir = path.join(stateDir, "agents");
    if (fs.lstatSync(agentsDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return { kind: "unavailable" };
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const agentDir = path.join(agentsDir, entry.name, "agent");
      if (
        entry.isSymbolicLink() ||
        fs.lstatSync(agentDir, { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        return { kind: "unavailable" };
      }
      candidates.add(path.join(agentDir, "openclaw-agent.sqlite"));
      for (const candidate of listSqliteTargetCandidatePathsInDirectory(agentDir)) {
        candidates.add(candidate);
      }
    }
    for (const candidate of candidates) {
      const family = resolveSqliteDatabaseFilePaths(candidate);
      const main = fs.lstatSync(candidate, { throwIfNoEntry: false });
      // Empty regular placeholders have no history; sidecars can still contain committed data.
      if (
        (main && (!main.isFile() || main.size > 0)) ||
        family.slice(1).some((file) => fs.lstatSync(file, { throwIfNoEntry: false }))
      ) {
        return { kind: "existing" };
      }
    }
    return { kind: "fresh" };
  } catch {
    return { kind: "unavailable" };
  }
}
