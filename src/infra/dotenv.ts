import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

// Keys that must never be loaded from workspace .env files to prevent
// trust-root hijacking (e.g., redirecting bundled hooks/plugins/skills).
const BLOCKED_WORKSPACE_DOTENV_KEYS = new Set([
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_BUNDLED_HOOKS_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_BUNDLED_SKILLS_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_SECRET",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_HOME",
  "OPENCLAW_PLUGINS_DIR",
  "OPENCLAW_SKILLS_DIR",
  "OPENCLAW_STATE_DIR",
]);

function isBlockedWorkspaceKey(key: string): boolean {
  return BLOCKED_WORKSPACE_DOTENV_KEYS.has(key);
}

function filterBlockedKeys(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isBlockedWorkspaceKey(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Load dotenv from a specific workspace .env file, blocking trust-root keys
 * to prevent workspace .env from hijacking bundled hooks/plugins/skills directories.
 */
export function loadWorkspaceDotEnvFile(envPath: string, opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  if (!fs.existsSync(envPath)) {
    return;
  }

  // First, capture what dotenv would load
  const loaded: Record<string, string> = {};
  const result = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(result)) {
    loaded[key] = value;
  }

  // Filter out blocked keys (trust-root hijacking prevention)
  const safe = filterBlockedKeys(loaded);

  // Now set the filtered keys into process.env
  for (const [key, value] of Object.entries(safe)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Load dotenv for CLI startup, blocking trust-root keys from workspace .env.
 */
export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from CWD first (workspace .env)
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (workspace .env), but block trust-root keys
  // to prevent workspace .env from hijacking bundled hooks/plugins/skills.
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
