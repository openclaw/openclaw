/** Filesystem discovery for local secret storage audits. */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { parseEnvValue } from "./shared.js";

/** Parses one .env assignment value using the shared shell-ish env parser. */
export function parseEnvAssignmentValue(raw: string): string {
  return parseEnvValue(raw);
}

/** Lists global dotenv files that can supply secrets for the selected config and state roots. */
export function listSecretsDotEnvPaths(params: { configPath: string; stateDir: string }): string[] {
  const candidates = [
    path.join(params.stateDir, ".env"),
    path.join(path.dirname(params.configPath), ".env"),
  ];
  return [...new Map(candidates.map((candidate) => [path.resolve(candidate), candidate])).values()];
}

/**
 * Lists deduplicated models.json paths that may contain materialized provider credentials.
 * Includes active env override, implicit main agent, discovered state dirs, and configured agents.
 */
export function listAgentModelsJsonPaths(
  config: OpenClawConfig,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const resolvedStateDir = resolveUserPath(stateDir, env);
  const paths = new Set<string>();
  paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
  const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    paths.add(path.join(resolveUserPath(override, env), "models.json"));
  }

  const agentsRoot = path.join(resolvedStateDir, "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "models.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    paths.add(path.join(resolveAgentDir(config, agentId, env), "models.json"));
  }

  return [...paths];
}
