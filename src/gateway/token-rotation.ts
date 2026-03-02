/**
 * Token rotation for the gateway auth token.
 *
 * T-ACCESS-003 recommends "token encryption at rest, add token rotation."
 * This module handles rotation: generate a new token, replace the old
 * one in config, and log the rotation event.
 *
 * Intended to be called by `openclaw auth rotate` CLI command.
 */

import { randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";

interface RotationResult {
  previousTokenPrefix: string;
  newTokenPrefix: string;
  rotatedAt: string;
  configPath: string;
}

/**
 * Generate a cryptographically random hex token.
 */
function generateToken(bytes: number = 24): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Rotate the gateway auth token in the config file.
 *
 * - Reads the current config
 * - Generates a new token
 * - Writes the updated config
 * - Returns metadata about the rotation (no full tokens logged)
 */
export function rotateToken(configPath: string): RotationResult {
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  const oldToken: string = config?.gateway?.auth?.token || "";
  const newToken = generateToken();

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.auth) config.gateway.auth = {};
  config.gateway.auth.token = newToken;

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  return {
    previousTokenPrefix: oldToken.slice(0, 4) + "****",
    newTokenPrefix: newToken.slice(0, 4) + "****",
    rotatedAt: new Date().toISOString(),
    configPath,
  };
}
