/**
 * Token rotation for the gateway auth token.
 *
 * T-ACCESS-003 recommends "token encryption at rest, add token rotation."
 * Generates a new token and atomically replaces the old one.
 *
 * Uses write-to-temp-then-rename to prevent config corruption.
 *
 * Note: Uses JSON.parse/stringify. If OpenClaw configs adopt JSON5
 * (comments, trailing commas), this should be updated to use a
 * JSON5-aware parser to preserve formatting and comments.
 */

import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";

interface RotationResult {
  previousTokenPrefix: string;
  newTokenPrefix: string;
  rotatedAt: string;
  configPath: string;
}

function generateToken(bytes: number = 24): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Atomically write content to a file.
 *
 * Writes to a temporary file in the same directory, then renames
 * over the target. rename() is atomic on POSIX filesystems, so a
 * crash at any point leaves either the old or new file intact.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.openclaw-tmp-${process.pid}-${Date.now()}`);

  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* temp may not exist */ }
    throw err;
  }
}

/**
 * Rotate the gateway auth token in the config file.
 */
export function rotateToken(configPath: string): RotationResult {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  const oldToken: string = config?.gateway?.auth?.token || "";
  const newToken = generateToken();

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.auth) config.gateway.auth = {};
  config.gateway.auth.token = newToken;

  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    previousTokenPrefix: oldToken.slice(0, 4) + "****",
    newTokenPrefix: newToken.slice(0, 4) + "****",
    rotatedAt: new Date().toISOString(),
    configPath,
  };
}
