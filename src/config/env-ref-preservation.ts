/**
 * Restores `${VAR}` environment variable references when writing config to disk.
 *
 * Problem: when config is read, `${VAR}` patterns are substituted with actual
 * env values.  If the resolved config is then written back (e.g. to update
 * `meta.lastTouchedAt`), secrets end up in plaintext on disk.
 *
 * Solution: before serialising, compare the resolved config to the *raw*
 * (pre-substitution) config read from the file.  For every string value that
 * was originally a `${VAR}` reference **and** whose resolved form hasn't
 * changed, the original reference is kept.  Changed or new fields use the
 * resolved value as-is.
 */

import { hasEnvVarRef, resolveConfigEnvVars } from "./env-substitution.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Walks two config trees (raw + resolved) in parallel and restores `${VAR}`
 * references wherever the resolved value hasn't actually changed from the
 * original env-var expansion.
 *
 * @param rawConfig  - The config as parsed from disk (before env-var substitution)
 * @param resolvedConfig - The config that would be written (env vars already resolved)
 * @param env - The current environment (used to re-resolve raw references for comparison)
 */
export function restoreEnvVarRefs(
  rawConfig: unknown,
  resolvedConfig: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  // --- String leaf: check if the raw value was a `${VAR}` reference --------
  if (typeof rawConfig === "string" && typeof resolvedConfig === "string") {
    if (hasEnvVarRef(rawConfig)) {
      try {
        const reResolved = resolveConfigEnvVars(rawConfig, env) as string;
        if (reResolved === resolvedConfig) {
          return rawConfig; // keep the ${VAR} reference
        }
      } catch {
        // env var missing or changed – fall through to use the resolved value
      }
    }
    return resolvedConfig;
  }

  // --- Plain objects: recurse per-key ---------------------------------------
  if (isPlainObject(rawConfig) && isPlainObject(resolvedConfig)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(resolvedConfig)) {
      if (key in rawConfig) {
        result[key] = restoreEnvVarRefs(rawConfig[key], resolvedConfig[key], env);
      } else {
        result[key] = resolvedConfig[key]; // new field
      }
    }
    return result;
  }

  // --- Arrays: recurse element-wise when lengths match ----------------------
  if (Array.isArray(rawConfig) && Array.isArray(resolvedConfig)) {
    if (rawConfig.length === resolvedConfig.length) {
      return resolvedConfig.map((item, idx) => restoreEnvVarRefs(rawConfig[idx], item, env));
    }
    return resolvedConfig;
  }

  // --- Type mismatch or primitive: use the resolved value -------------------
  return resolvedConfig;
}
