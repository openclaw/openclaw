import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "./host-env-security.js";

const BLOCKED_WORKSPACE_DOTENV_KEYS = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_HOME",
  "OPENCLAW_OAUTH_DIR",
  "OPENCLAW_PROFILE",
  "PI_CODING_AGENT_DIR",
]);

/**
 * Keys that control path resolution and are allowed from a workspace .env only
 * when the value is an absolute path. Relative paths are blocked to prevent a
 * malicious workspace from redirecting config/state loading to an attacker-
 * controlled location (e.g. `OPENCLAW_CONFIG_PATH=./evil-config.json`).
 */
const ABSOLUTE_PATH_ONLY_WORKSPACE_DOTENV_KEYS = new Set([
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
]);

const BLOCKED_WORKSPACE_DOTENV_SUFFIXES = ["_BASE_URL"];

function shouldBlockRuntimeDotEnvKey(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

function shouldBlockWorkspaceDotEnvEntry(key: string, value: string): boolean {
  const upper = key.toUpperCase();
  if (shouldBlockRuntimeDotEnvKey(upper)) {
    return true;
  }
  if (BLOCKED_WORKSPACE_DOTENV_KEYS.has(upper)) {
    return true;
  }
  if (BLOCKED_WORKSPACE_DOTENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))) {
    return true;
  }
  // Allow path-override keys only when the value is an absolute path.
  // Relative paths could redirect config loading to a malicious workspace file.
  if (ABSOLUTE_PATH_ONLY_WORKSPACE_DOTENV_KEYS.has(upper)) {
    return !path.isAbsolute(value.trim());
  }
  return false;
}

function loadDotEnvFile(params: {
  filePath: string;
  shouldBlockEntry: (key: string, value: string) => boolean;
  quiet?: boolean;
}) {
  let content: string;
  try {
    content = fs.readFileSync(params.filePath, "utf8");
  } catch (error) {
    if (!params.quiet) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") {
        console.warn(`[dotenv] Failed to read ${params.filePath}: ${String(error)}`);
      }
    }
    return;
  }

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(content);
  } catch (error) {
    if (!params.quiet) {
      console.warn(`[dotenv] Failed to parse ${params.filePath}: ${String(error)}`);
    }
    return;
  }
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || params.shouldBlockEntry(key, value)) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

export function loadRuntimeDotEnvFile(filePath: string, opts?: { quiet?: boolean }) {
  loadDotEnvFile({
    filePath,
    shouldBlockEntry: (key) => shouldBlockRuntimeDotEnvKey(key),
    quiet: opts?.quiet ?? true,
  });
}

export function loadWorkspaceDotEnvFile(filePath: string, opts?: { quiet?: boolean }) {
  loadDotEnvFile({
    filePath,
    shouldBlockEntry: shouldBlockWorkspaceDotEnvEntry,
    quiet: opts?.quiet ?? true,
  });
}

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  loadRuntimeDotEnvFile(globalEnvPath, { quiet });
}
