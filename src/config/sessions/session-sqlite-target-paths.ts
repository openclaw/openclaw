import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { hasErrnoCode } from "../../infra/errno.js";

/** Inventory main-file locators, including families whose main file is missing. */
export function listSqliteTargetCandidatePathsInDirectory(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            (entry.isFile() || entry.isSymbolicLink()) &&
            /\.sqlite(?:-(?:wal|shm|journal))?$/u.test(entry.name),
        )
        .map((entry) => path.join(directory, entry.name.replace(/-(?:wal|shm|journal)$/u, ""))),
    ),
  ].toSorted();
}

/** Resolves only the legacy unsuffixed target, without reading ownership state. */
export function resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath: string): {
  agentId?: string;
  path: string;
  shared?: boolean;
} {
  const resolved = path.resolve(storePath);
  if (resolved.endsWith(".sqlite")) {
    const agentId = resolveAgentIdFromSqliteDatabasePath(resolved);
    return { path: resolved, ...(agentId ? { agentId } : { shared: true }) };
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(resolved) !== "sessions.json") {
    const sqliteBaseName = path.basename(resolved, path.extname(resolved)) || "openclaw-agent";
    return { path: path.join(sessionsDir, `${sqliteBaseName}.sqlite`) };
  }
  if (path.basename(sessionsDir) !== "sessions") {
    return { path: path.join(sessionsDir, "openclaw-agent.sqlite") };
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return { path: path.join(sessionsDir, "openclaw-agent.sqlite") };
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
}

/** List inspection candidates without opening stores or assigning writable ownership. */
export function listSqliteTargetCandidatePathsForSessionStorePath(storePath: string): string[] {
  const unsuffixedTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  if (unsuffixedTarget.agentId || unsuffixedTarget.shared) {
    return [unsuffixedTarget.path];
  }
  const directory = path.dirname(unsuffixedTarget.path);
  const baseName = path.basename(unsuffixedTarget.path, ".sqlite");
  const candidateNames = new Set([path.basename(unsuffixedTarget.path)]);
  try {
    for (const fileName of readdirSync(directory)) {
      const databaseName = fileName.replace(/-(?:wal|shm|journal)$/u, "");
      if (databaseName.startsWith(`${baseName}.`) && databaseName.endsWith(".sqlite")) {
        candidateNames.add(databaseName);
      }
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return [...candidateNames].map((fileName) => path.join(directory, fileName));
}

/** Extracts the agent id from the canonical per-agent SQLite database path. */
function resolveAgentIdFromSqliteDatabasePath(databasePath: string): string | undefined {
  if (path.basename(databasePath) !== "openclaw-agent.sqlite") {
    return undefined;
  }
  const agentDbDir = path.dirname(databasePath);
  if (path.basename(agentDbDir) !== "agent") {
    return undefined;
  }
  const agentDir = path.dirname(agentDbDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return undefined;
  }
  return normalizeAgentId(path.basename(agentDir));
}
