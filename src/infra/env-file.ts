import fs from "node:fs";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

const ENV_KEY_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export type UpsertSharedEnvVarResult = { path: string };

/**
 * Upsert a single KEY=value line into the shared .env file
 * (~/.openclaw/.env or OPENCLAW_STATE_DIR/.env). Used for launchd compatibility
 * so the gateway can read e.g. OPENAI_API_KEY from the same file.
 */
export function upsertSharedEnvVar(params: {
  key: string;
  value: string;
}): UpsertSharedEnvVarResult {
  const configDir = resolveConfigDir(process.env);
  const envPath = path.join(configDir, ".env");

  let raw = "";
  if (fs.existsSync(envPath)) {
    raw = fs.readFileSync(envPath, "utf8");
  }

  const lines = raw.split(/\r?\n/);
  const key = params.key.trim();
  const value = params.value;
  let found = false;
  const nextLines = lines.map((line) => {
    const match = line.match(ENV_KEY_PATTERN);
    if (match && (match[1] ?? "").trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    nextLines.push(`${key}=${value}`);
  }

  const joined = nextLines.join("\n");
  const content = joined + (joined.endsWith("\n") ? "" : "\n");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${envPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, envPath);

  return { path: envPath };
}
