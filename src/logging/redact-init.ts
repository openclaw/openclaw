/**
 * Initialization module for dynamic sensitive value detection.
 * Scans configuration and environment variables to identify secrets that should be redacted.
 */

import type { OpenClawConfig } from "../config/config.js";
import { addSensitiveValues } from "./redact.js";

/**
 * Patterns for identifying sensitive configuration keys.
 */
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /private[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /auth/i,
];

/**
 * Check if a key name suggests it contains sensitive data.
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Extract sensitive string values from an object recursively.
 */
function extractSensitiveValues(
  obj: unknown,
  keyPath: string = "",
  depth: number = 0,
): string[] {
  const MAX_DEPTH = 10;
  const MIN_VALUE_LENGTH = 18; // Match DEFAULT_REDACT_MIN_LENGTH.

  if (depth > MAX_DEPTH || obj === null || typeof obj !== "object") {
    return [];
  }

  const values: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = keyPath ? `${keyPath}.${key}` : key;

    // Check if this key is sensitive.
    if (isSensitiveKey(key)) {
      if (typeof value === "string" && value.length >= MIN_VALUE_LENGTH) {
        values.push(value);
      }
    }

    // Recurse into nested objects and arrays.
    if (typeof value === "object" && value !== null) {
      values.push(...extractSensitiveValues(value, fullPath, depth + 1));
    }
  }

  return values;
}

/**
 * Scan environment variables for sensitive values.
 */
function scanEnvironmentVariables(): string[] {
  const values: string[] = [];
  const MIN_VALUE_LENGTH = 18;

  for (const [key, value] of Object.entries(process.env)) {
    if (isSensitiveKey(key) && value && value.length >= MIN_VALUE_LENGTH) {
      values.push(value);
    }
  }

  return values;
}

/**
 * Scan OpenClaw configuration for sensitive values.
 */
function scanConfig(config: OpenClawConfig): string[] {
  const values: string[] = [];

  // Scan Docker environment variables in agent defaults.
  const dockerEnv = config.agents?.defaults?.sandbox?.docker?.env;
  if (dockerEnv && typeof dockerEnv === "object") {
    values.push(...extractSensitiveValues(dockerEnv, "agents.defaults.sandbox.docker.env"));
  }

  // Scan provider configurations (Telegram, Discord, Slack, etc.).
  if (config.providers && typeof config.providers === "object") {
    values.push(...extractSensitiveValues(config.providers, "providers"));
  }

  // Scan gateway configuration.
  if (config.gateway && typeof config.gateway === "object") {
    values.push(...extractSensitiveValues(config.gateway, "gateway"));
  }

  // Scan plugin configurations.
  if (config.plugins && Array.isArray(config.plugins)) {
    for (let i = 0; i < config.plugins.length; i++) {
      const plugin = config.plugins[i];
      if (plugin && typeof plugin === "object") {
        values.push(...extractSensitiveValues(plugin, `plugins[${i}]`));
      }
    }
  }

  return values;
}

/**
 * Initialize redaction with sensitive values from config and environment.
 * Call this during application startup.
 */
export function initializeRedactionWithConfig(config: OpenClawConfig): void {
  const configValues = scanConfig(config);
  const envValues = scanEnvironmentVariables();

  const allValues = [...new Set([...configValues, ...envValues])];

  if (allValues.length > 0) {
    addSensitiveValues(allValues);
  }
}

/**
 * Scan and register sensitive values for redaction.
 * This is a convenience wrapper that loads config and initializes redaction.
 */
export async function initializeRedaction(config?: OpenClawConfig): Promise<{
  configValuesFound: number;
  envValuesFound: number;
  totalRegistered: number;
}> {
  let cfg = config;
  if (!cfg) {
    try {
      const { loadConfig } = await import("../config/config.js");
      cfg = loadConfig();
    } catch {
      // If config loading fails, only scan environment variables.
      const envValues = scanEnvironmentVariables();
      const uniqueValues = [...new Set(envValues)];
      addSensitiveValues(uniqueValues);
      return {
        configValuesFound: 0,
        envValuesFound: uniqueValues.length,
        totalRegistered: uniqueValues.length,
      };
    }
  }

  const configValues = scanConfig(cfg);
  const envValues = scanEnvironmentVariables();

  const allValues = [...new Set([...configValues, ...envValues])];

  addSensitiveValues(allValues);

  return {
    configValuesFound: configValues.length,
    envValuesFound: envValues.length,
    totalRegistered: allValues.length,
  };
}
