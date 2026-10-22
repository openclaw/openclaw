import path from "node:path";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";

/** Recovery also inventories disk collisions at the reserved incognito filename. */
export function resolveOpenClawAgentDatabaseDiscoveryPaths(params: {
  agentDir: string;
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [
    resolveOpenClawAgentSqlitePath(params),
    resolveIncognitoOpenClawAgentSqlitePath(params),
  ].map((pathname) => path.join(params.agentDir, path.basename(pathname)));
}
