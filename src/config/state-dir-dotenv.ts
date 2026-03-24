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

/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`).
 *
 * These vars are durable runtime inputs, but should not be baked into service
 * manager metadata (for example launchd plist EnvironmentVariables) because
 * that creates a stale second source of truth that can override later `.env`
 * edits on restart.
 */
export function readStateDirDotEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const dotEnvPath = path.join(stateDir, ".env");

  let content: string;
  try {
    content = fs.readFileSync(dotEnvPath, "utf8");
  } catch {
    return {};
  }

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
    entries[key] = value;
  }
  return entries;
}

/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into service install metadata.
 *
 * Intentionally excludes state-dir `.env` values: those should be read at
 * process startup, not duplicated into launchd/systemd/task metadata where they
 * would become stale after `.env` edits.
 */
export function collectDurableServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): Record<string, string> {
  return {
    ...collectConfigServiceEnvVars(params.config),
  };
}
