import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

const OPENCLAW_AGENT_DB_DIR_MODE = 0o700;
const OPENCLAW_AGENT_DB_FILE_MODE = 0o600;

function ensureMode(target: string, mode: number): void {
  // Recheck each time: modes may drift, but reapplying them also writes filesystem metadata.
  if (process.platform === "win32" || (statSync(target).mode & 0o7777) !== mode) {
    chmodSync(target, mode);
  }
}

export function ensureOpenClawAgentDatabasePermissions(
  pathname: string,
  options: OpenClawAgentDatabaseOptions,
): void {
  const dir = path.dirname(pathname);
  const defaultPath = resolveOpenClawAgentSqlitePath({
    agentId: options.agentId,
    env: options.env,
  });
  const isDefaultAgentDatabase = path.resolve(pathname) === path.resolve(defaultPath);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_AGENT_DB_DIR_MODE });
  // Default agent state is private by contract; custom pre-existing dirs keep caller ownership.
  if (isDefaultAgentDatabase || !dirExisted) {
    ensureMode(dir, OPENCLAW_AGENT_DB_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      ensureMode(candidate, OPENCLAW_AGENT_DB_FILE_MODE);
    } catch (error) {
      // WAL/SHM/journal sidecars are transient: SQLite removes them at
      // checkpoint/close, so a concurrent worker can race this sweep. A
      // vanished sidecar needs no tightening, whether stat or chmod observed its removal.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
