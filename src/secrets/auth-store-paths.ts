/** Discovers auth-profile store paths that may contain secret refs. */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

/**
 * Lists deduplicated auth-profile store agent dirs that may contain SecretRefs.
 * Covers implicit main, discovered state-dir agents, and config-declared agent dirs.
 */
export function listAuthProfileStoreAgentDirs(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so scans do not include unrelated host-global stores.
  // Use the configured default agent instead of hard-coding "main" so deployments
  // that set `default: true` on a non-"main" agent resolve the correct store path.
  const defaultAgentId = resolveDefaultAgentId(config);
  paths.add(path.join(resolveUserPath(stateDir), "agents", defaultAgentId, "agent"));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent"));
    }
  }

  // Configured agent dirs may live outside stateDir; include them after state-dir discovery.
  for (const agentId of listAgentIds(config)) {
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(agentDir));
  }

  return [...paths];
}
