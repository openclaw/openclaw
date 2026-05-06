import fs from "node:fs";
import path from "node:path";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

const FILE_REF_PREFIX = "file:";

/**
 * Resolve a `file:<relpath>` env var value by reading the referenced file.
 * The path is resolved relative to the OpenClaw state directory (~/.openclaw).
 * Path traversal outside the state directory is rejected.
 */
function resolveFileEnvRef(
  value: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const relPath = value.slice(FILE_REF_PREFIX.length).trim();
  if (!relPath) {
    return undefined;
  }
  const stateDir = resolveStateDir(env);
  const resolved = path.resolve(stateDir, relPath);
  // Path traversal protection: resolved path must be inside stateDir
  const normalizedStateDir = path.resolve(stateDir) + path.sep;
  const normalizedResolved = path.resolve(resolved);
  if (
    normalizedResolved !== path.resolve(stateDir) &&
    !normalizedResolved.startsWith(normalizedStateDir)
  ) {
    throw new Error(
      `Config env file ref "${value}" resolves outside the OpenClaw state directory: ${normalizedResolved}`,
    );
  }
  try {
    const content = fs.readFileSync(resolved, "utf8");
    return content.replace(/\r?\n$/, "");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Config env file ref "${value}" not found at ${resolved}${code ? ` (${code})` : ""}`,
      { cause: err },
    );
  }
}

function isBlockedConfigEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        continue;
      }
      if (isBlockedConfigEnvVar(key)) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [rawKey, value] of Object.entries(envConfig)) {
    if (rawKey === "shellEnv" || rawKey === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedConfigEnvVar(key)) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

export function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  applyConfigEnvVars(cfg, env);
  return env;
}

export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entries = collectConfigRuntimeEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) {
      continue;
    }
    // Skip values containing unresolved ${VAR} references — applyConfigEnvVars runs
    // before env substitution, so these would pollute process.env with literal placeholders
    // (e.g. process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}") which downstream auth
    // resolution would accept as valid credentials.
    if (containsEnvVarReference(value)) {
      continue;
    }
    // Resolve file: references — read file content as the env var value
    if (value.startsWith(FILE_REF_PREFIX)) {
      env[key] = resolveFileEnvRef(value, env);
      continue;
    }
    env[key] = value;
  }
}
