/**
 * Token rotation for the gateway auth token.
 *
 * T-ACCESS-003 recommends "token encryption at rest, add token rotation."
 * This module handles rotation: generate a new token, replace the old
 * one in config, and log the rotation event.
 *
 * Uses atomic write (write-to-temp, then rename) to prevent config
 * corruption if the process crashes mid-write.
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
 * it over the target. rename() is atomic on POSIX filesystems,
 * so a crash at any point leaves either the old or new file
 * intact — never a truncated file.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.openclaw-tmp-${process.pid}-${Date.now()}`);

  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp file may not exist, ignore
    }
    throw err;
  }
}

/**
 * Rotate the gateway auth token in the config file.
 *
 * - Reads the current config
 * - Generates a new token
 * - Atomically writes the updated config
 * - Returns metadata about the rotation (no full tokens exposed)
 */
export function rotateToken(configPath: string): RotationResult {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  const oldToken: string = config?.gateway?.auth?.token || "";
  const newToken = generateToken();

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.auth) config.gateway.auth = {};
  config.gateway.auth.token = newToken;

  const updatedContent = JSON.stringify(config, null, 2);
  atomicWriteFileSync(configPath, updatedContent);

  return {
    previousTokenPrefix: oldToken.slice(0, 4) + "****",
    newTokenPrefix: newToken.slice(0, 4) + "****",
    rotatedAt: new Date().toISOString(),
    configPath,
  };
}
