import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { listAuthProfileStoreAgentDirs as listAuthProfileStoreAgentDirsFromAuthStorePaths } from "./auth-store-paths.js";
import { parseEnvValue } from "./shared.js";

export function parseEnvAssignmentValue(raw: string): string {
  return parseEnvValue(raw);
}

export function listAuthProfileStoreAgentDirs(config: OpenClawConfig, stateDir: string): string[] {
  return listAuthProfileStoreAgentDirsFromAuthStorePaths(config, stateDir);
}

function resolveActiveAgentDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(resolveUserPath(stateDir), "agents", "main", "agent");
}

export function listAgentModelCatalogDirs(
  config: OpenClawConfig,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const resolvedStateDir = resolveUserPath(stateDir);
  const dirs = new Set<string>();
  dirs.add(path.join(resolvedStateDir, "agents", "main", "agent"));
  dirs.add(resolveActiveAgentDir(stateDir, env));

  const agentsRoot = path.join(resolvedStateDir, "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      dirs.add(path.join(agentsRoot, entry.name, "agent"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    if (agentId === "main") {
      dirs.add(path.join(resolvedStateDir, "agents", "main", "agent"));
      continue;
    }
    const agentDir = resolveAgentDir(config, agentId);
    dirs.add(resolveUserPath(agentDir));
  }

  return [...dirs];
}
