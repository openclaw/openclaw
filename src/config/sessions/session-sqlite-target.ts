import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";

/** SQLite database target resolved from a legacy session store path. */
export type ResolvedSqliteStoreTarget = {
  agentId?: string;
  path?: string;
};

/** Resolves the SQLite database target that owns a legacy session store path. */
export function resolveSqliteTargetFromSessionStorePath(
  storePath: string,
): ResolvedSqliteStoreTarget {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) === "openclaw-agent.sqlite" || resolved.endsWith(".sqlite")) {
    const agentId = resolveAgentIdFromSqliteDatabasePath(resolved);
    return {
      path: resolved,
      ...(agentId ? { agentId } : {}),
    };
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(resolved) !== "sessions.json") {
    return {
      path: path.join(sessionsDir, "openclaw-agent.sqlite"),
    };
  }
  if (path.basename(sessionsDir) !== "sessions") {
    return {
      path: path.join(sessionsDir, "openclaw-agent.sqlite"),
    };
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return {
      path: path.join(sessionsDir, "openclaw-agent.sqlite"),
    };
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
}

/** Extracts the agent id from the canonical per-agent SQLite database path. */
export function resolveAgentIdFromSqliteDatabasePath(databasePath: string): string | undefined {
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
