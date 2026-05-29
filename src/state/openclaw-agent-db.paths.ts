import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type OpenClawAgentSqlitePathOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

export function resolveOpenClawAgentSqlitePath(options: OpenClawAgentSqlitePathOptions): string {
  const agentId = normalizeAgentId(options.agentId);
  return (
    options.path ??
    path.join(
      resolveStateDir(options.env ?? process.env),
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    )
  );
}

export function resolveOpenClawAgentSqliteDir(options: OpenClawAgentSqlitePathOptions): string {
  return path.dirname(resolveOpenClawAgentSqlitePath(options));
}
