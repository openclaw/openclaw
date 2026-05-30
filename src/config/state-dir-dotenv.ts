import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { collectConfigServiceEnvVars } from "./config-env-vars.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

function isBlockedServiceEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

function isUnresolvedShellReference(value: string): boolean {
  // Match only values whose entire content is a shell variable reference:
  //   $VAR_NAME          (simple reference — must start with a letter or underscore)
  //   ${VAR_NAME}        (brace-form reference)
  //   $(command)         (command substitution)
  // A real credential that merely contains a $ (e.g. "abc$2!", "$100") is NOT matched.
  return /^\$[A-Za-z_]\w*$/.test(value) || /^\$\{[^}]+\}$/.test(value) || /^\$\(.*\)$/.test(value);
}

function parseStateDirDotEnvContent(content: string): Record<string, string> {
  const parsed = dotenv.parse(content);
  const entries: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(parsed)) {
    if (!value?.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedServiceEnvVar(key)) {
      continue;
    }
    // Skip values whose entire content is an unresolved shell variable reference
    // ($VAR, ${VAR}, or $(cmd)). dotenv does not expand them, so persisting them
    // into a single-quoted LaunchAgent/systemd env file would store the literal
    // reference string rather than the intended credential value.
    // Values that merely contain $ (e.g. a password like "abc$2!") are kept.
    if (isUnresolvedShellReference(value)) {
      continue;
    }
    entries[key] = value;
  }
  return entries;
}

export function readStateDirDotEnvVarsFromStateDir(stateDir: string): Record<string, string> {
  const dotEnvPath = path.join(stateDir, ".env");
  try {
    return parseStateDirDotEnvContent(fs.readFileSync(dotEnvPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for a managed service
 * environment source.
 */
export function readStateDirDotEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  return readStateDirDotEnvVarsFromStateDir(stateDir);
}

export type DurableServiceEnvVarSources = {
  stateDirDotEnvEnvironment: Record<string, string>;
  configEnvironment: Record<string, string>;
  durableEnvironment: Record<string, string>;
};

export function collectDurableServiceEnvVarSources(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): DurableServiceEnvVarSources {
  const stateDirDotEnvEnvironment = readStateDirDotEnvVars(params.env);
  const configEnvironment = collectConfigServiceEnvVars(params.config);
  return {
    stateDirDotEnvEnvironment,
    configEnvironment,
    durableEnvironment: {
      ...stateDirDotEnvEnvironment,
      ...configEnvironment,
    },
  };
}

/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into owner-only gateway service environment sources.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export function collectDurableServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): Record<string, string> {
  return collectDurableServiceEnvVarSources(params).durableEnvironment;
}
