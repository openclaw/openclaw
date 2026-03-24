/**
 * Environment variable compatibility layer for EVOX.sh rebrand.
 * Supports both EVOX_* (new) and OPENCLAW_* (legacy) env vars.
 *
 * Priority: EVOX_* > OPENCLAW_* (new takes precedence)
 *
 * Usage:
 *   import { getEnv, getEnvBool, getEnvInt } from "./env-compat.js";
 *   const home = getEnv(env, "HOME"); // checks EVOX_HOME, then OPENCLAW_HOME
 */

/**
 * Get env var with EVOX_ / OPENCLAW_ fallback.
 * @param env Process environment
 * @param name Var name without prefix (e.g., "HOME" for EVOX_HOME/OPENCLAW_HOME)
 * @param defaultValue Optional default if neither exists
 */
export function getEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue?: string,
): string | undefined {
  const evoxKey = `EVOX_${name}`;
  const openclawKey = `OPENCLAW_${name}`;

  const evoxVal = env[evoxKey]?.trim();
  if (evoxVal && evoxVal !== "undefined" && evoxVal !== "null") {
    return evoxVal;
  }

  const openclawVal = env[openclawKey]?.trim();
  if (openclawVal && openclawVal !== "undefined" && openclawVal !== "null") {
    return openclawVal;
  }

  return defaultValue;
}

/**
 * Get boolean env var with fallback.
 * Truthy: "1", "true", "yes", "on" (case-insensitive)
 */
export function getEnvBool(env: NodeJS.ProcessEnv, name: string, defaultValue = false): boolean {
  const value = getEnv(env, name);
  if (value === undefined) {
    return defaultValue;
  }
  const lower = value.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

/**
 * Get integer env var with fallback.
 */
export function getEnvInt(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue?: number,
): number | undefined {
  const value = getEnv(env, name);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Get raw env var (either EVOX_* or OPENCLAW_* directly).
 * For cases where the full var name is dynamic.
 */
export function getRawEnv(
  env: NodeJS.ProcessEnv,
  evoxKey: string,
  openclawKey: string,
  defaultValue?: string,
): string | undefined {
  const evoxVal = env[evoxKey]?.trim();
  if (evoxVal && evoxVal !== "undefined" && evoxVal !== "null") {
    return evoxVal;
  }

  const openclawVal = env[openclawKey]?.trim();
  if (openclawVal && openclawVal !== "undefined" && openclawVal !== "null") {
    return openclawVal;
  }

  return defaultValue;
}

/**
 * Check if either EVOX_* or OPENCLAW_* var is set.
 */
export function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return getEnv(env, name) !== undefined;
}

/**
 * Set env var with EVOX_* prefix (new standard).
 * Does NOT set OPENCLAW_* - that's legacy read-only.
 */
export function setEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[`EVOX_${name}`] = value;
}
