import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";

export function parseEnvAssignmentValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function listAuthProfileStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so scans do not include unrelated host-global stores.
  paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    if (agentId === "main") {
      paths.add(
        path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"),
      );
      continue;
    }
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
  }

  return [...paths];
}

export function listLegacyAuthJsonPaths(stateDir: string): string[] {
  const out: string[] = [];
  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (!fs.existsSync(agentsRoot)) {
    return out;
  }
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(agentsRoot, entry.name, "agent", "auth.json");
    if (fs.existsSync(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

export function readJsonObjectIfExists(filePath: string): {
  value: Record<string, unknown> | null;
  error?: string;
} {
  if (!fs.existsSync(filePath)) {
    return { value: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      value: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
