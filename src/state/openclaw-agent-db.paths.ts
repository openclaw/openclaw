// Agent database path helpers resolve per-agent persisted database paths.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Path helpers for per-agent SQLite state.
 *
 * Agent databases live beside the shared state database root so each agent can
 * own private runtime tables while the shared registry can still discover them.
 */
/** Inputs for resolving one agent SQLite path or directory. */
type OpenClawAgentSqlitePathOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

export const INCOGNITO_AGENT_SQLITE_BASENAME = "incognito-openclaw-agent.sqlite";

const agentSqlitePaths = new Map<string, string>();
// Keep the FIFO cursor so eviction never rescans deleted Map entries.
const agentSqlitePathKeys = agentSqlitePaths.keys();

/** Resolve the SQLite file for one normalized agent id. */
export function resolveOpenClawAgentSqlitePath(options: OpenClawAgentSqlitePathOptions): string {
  const agentId = normalizeAgentId(options.agentId);
  if (options.path != null) {
    return path.resolve(options.path);
  }
  // The state-dir owner still observes env, cwd, and legacy-directory changes.
  // Only its resolved output is memoized; a changed root selects a new entry.
  const stateDir = resolveStateDir(options.env ?? process.env);
  const cacheKey = `${agentId}:${stateDir}`;
  const cached = agentSqlitePaths.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = path.resolve(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  agentSqlitePaths.set(cacheKey, resolved);
  if (agentSqlitePaths.size > 256) {
    const oldest = agentSqlitePathKeys.next();
    if (!oldest.done) {
      agentSqlitePaths.delete(oldest.value);
    }
  }
  return resolved;
}

/** Resolve the lexical sentinel path that keys one agent's process-held incognito database. */
export function resolveIncognitoOpenClawAgentSqlitePath(
  options: Omit<OpenClawAgentSqlitePathOptions, "path">,
): string {
  return path.join(
    path.dirname(resolveOpenClawAgentSqlitePath(options)),
    INCOGNITO_AGENT_SQLITE_BASENAME,
  );
}

/** Identify the reserved incognito sentinel without touching its filesystem path. */
export function isIncognitoOpenClawAgentSqlitePath(
  pathname: string,
  options: Omit<OpenClawAgentSqlitePathOptions, "path">,
): boolean {
  const resolved = path.resolve(pathname);
  return (
    path.basename(resolved) === INCOGNITO_AGENT_SQLITE_BASENAME &&
    resolved === resolveIncognitoOpenClawAgentSqlitePath(options)
  );
}
