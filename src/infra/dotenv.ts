import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { logDebug } from "../logger.js";
import { resolveConfigDir } from "../utils.js";
import { isDangerousHostEnvVarName } from "./host-env-security.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}

const MAX_WORKSPACE_ENV_BYTES = 1 * 1024 * 1024;

export function parseWorkspaceDotEnv(workspaceDir: string): Record<string, string> {
  const envPath = path.join(workspaceDir, ".env");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(envPath);
  } catch {
    return {};
  }
  if (!stat.isFile()) {
    return {};
  }
  if (stat.size > MAX_WORKSPACE_ENV_BYTES) {
    logDebug(`workspace .env skipped (too large: ${stat.size} bytes): ${envPath}`);
    return {};
  }

  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    return {};
  }
  const parsed = dotenv.parse(content);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && !isDangerousHostEnvVarName(key)) {
      result[key] = value;
    }
  }
  const keyCount = Object.keys(result).length;
  if (keyCount > 0) {
    logDebug(`workspace .env loaded: ${envPath} (${keyCount} var${keyCount === 1 ? "" : "s"})`);
  }
  return result;
}
