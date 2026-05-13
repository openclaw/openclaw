import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

export function listAuthProfileStoreAgentDirs(config: OpenClawConfig, stateDir: string): string[] {
  const dirs = new Set<string>();
  const resolvedStateDir = resolveUserPath(stateDir);
  dirs.add(path.join(resolvedStateDir, "agents", "main", "agent"));

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
