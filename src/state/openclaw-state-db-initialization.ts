import fs from "node:fs";
import path from "node:path";
import { readAgentStorePathsFromConfig } from "../config/agent-store-source.js";
import { listSqliteTargetCandidatePathsInDirectory } from "../config/sessions/session-sqlite-target-paths.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { resolveOpenClawStateDirForDatabasePath } from "./openclaw-state-db.paths.js";

export type StateDatabaseInitialization = { kind: "fresh" | "existing" | "unavailable" };

/** Capture deletion-history evidence before a native open can create the shared database. */
export function prepareStateDatabaseInitialization(
  pathname: string,
  env: NodeJS.ProcessEnv,
): StateDatabaseInitialization {
  try {
    if (
      resolveSqliteDatabaseFilePaths(pathname).some((file) =>
        fs.lstatSync(file, { throwIfNoEntry: false }),
      )
    ) {
      return { kind: "existing" };
    }
    const stateDir = resolveOpenClawStateDirForDatabasePath(pathname);
    const candidates = new Set(readAgentStorePathsFromConfig(env, stateDir));
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
      candidates.add(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
    for (const candidate of candidates) {
      if (
        resolveSqliteDatabaseFilePaths(candidate).some((file) =>
          fs.lstatSync(file, { throwIfNoEntry: false }),
        )
      ) {
        return { kind: "existing" };
      }
    }
    return { kind: "fresh" };
  } catch {
    return { kind: "unavailable" };
  }
}
