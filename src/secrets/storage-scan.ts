import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { listAuthProfileStorePaths as listAuthProfileStorePathsFromAuthStorePaths } from "./auth-store-paths.js";
import { parseEnvValue } from "./shared.js";

export function parseEnvAssignmentValue(raw: string): string {
  return parseEnvValue(raw);
}

export function listAuthProfileStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  return listAuthProfileStorePathsFromAuthStorePaths(config, stateDir);
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
