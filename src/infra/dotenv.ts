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
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
]);

const BLOCKED_WORKSPACE_DOTENV_SUFFIXES = ["_BASE_URL"];

function shouldBlockRuntimeDotEnvKey(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

function shouldBlockWorkspaceDotEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    shouldBlockRuntimeDotEnvKey(upper) ||
    BLOCKED_WORKSPACE_DOTENV_KEYS.has(upper) ||
    BLOCKED_WORKSPACE_DOTENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

function loadDotEnvFile(params: { filePath: string; shouldBlockKey: (key: string) => boolean }) {
  let content: string;
  try {
    content = fs.readFileSync(params.filePath, "utf8");
  } catch {
    return;
  }

  const parsed = dotenv.parse(content);
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || params.shouldBlockKey(key)) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

export function loadRuntimeDotEnvFile(filePath: string) {
  loadDotEnvFile({
    filePath,
    shouldBlockKey: shouldBlockRuntimeDotEnvKey,
  });
}

export function loadWorkspaceDotEnvFile(filePath: string) {
  loadDotEnvFile({
    filePath,
    shouldBlockKey: shouldBlockWorkspaceDotEnvKey,
  });
}

export function loadDotEnv(_opts?: { quiet?: boolean }) {
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath);

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  loadRuntimeDotEnvFile(globalEnvPath);
}
