/**
 * Environment variable substitution for config values.
 *
 * Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
 * - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 * - Escape with `$${}` to output literal `${}`
 * - Missing env vars throw `MissingEnvVarError` with context
 *
 * @example
 * ```json5
 * {
 *   models: {
 *     providers: {
 *       "vercel-gateway": {
 *         apiKey: "${VERCEL_GATEWAY_API_KEY}"
 *       }
 *     }
 *   }
 * }
 * ```
 */

// Pattern for valid uppercase env var names: starts with letter or underscore,
// followed by letters, numbers, or underscores (all uppercase)
import { isPlainObject } from "../utils.js";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

function substituteString(value: string, env: NodeJS.ProcessEnv, configPath: string): string {
  if (!value.includes("$")) {
    return value;
  }

  const chunks: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "$") {
      chunks.push(char);
      continue;
    }

    const next = value[i + 1];
    const afterNext = value[i + 2];

    // Escaped: $${VAR} -> ${VAR}
    if (next === "$" && afterNext === "{") {
      const start = i + 3;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const name = value.slice(start, end);
        if (ENV_VAR_NAME_PATTERN.test(name)) {
          chunks.push(`\${${name}}`);
          i = end;
          continue;
        }
      }
    }

    // Substitution: ${VAR} -> value
    if (next === "{") {
      const start = i + 2;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const name = value.slice(start, end);
        if (ENV_VAR_NAME_PATTERN.test(name)) {
          const envValue = env[name];
          if (envValue === undefined || envValue === "") {
            throw new MissingEnvVarError(name, configPath);
          }
          chunks.push(envValue);
          i = end;
          continue;
        }
      }
    }

    // Leave untouched if not a recognized pattern
    chunks.push(char);
  }

  return chunks.join("");
}

function substituteAny(value: unknown, env: NodeJS.ProcessEnv, path: string): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, path);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteAny(val, env, childPath);
    }
    return result;
  }

  // Primitives (number, boolean, null) pass through unchanged
  return value;
}

/**
 * Resolves `${VAR_NAME}` environment variable references in config values.
 *
 * @param obj - The parsed config object (after JSON5 parse and $include resolution)
 * @param env - Environment variables to use for substitution (defaults to process.env)
 * @returns The config object with env vars substituted
 * @throws {MissingEnvVarError} If a referenced env var is not set or empty
 */
export function resolveConfigEnvVars(obj: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  return substituteAny(obj, env, "");
}

// ---------------------------------------------------------------------------
// Env var reference preservation for config writes
// ---------------------------------------------------------------------------

const ENV_REF_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)}/;

function containsEnvRef(value: string): boolean {
  return ENV_REF_PATTERN.test(value);
}

/**
 * Collects a map of dotted config paths to their original string values
 * that contain `${VAR}` references.
 *
 * Only strings that contain at least one `${VAR}` reference are collected.
 * This allows `restoreEnvVarRefs` to restore original `${VAR}` syntax
 * when writing config back to disk.
 */
function collectEnvRefs(value: unknown, path: string, refs: Map<string, string>): void {
  if (typeof value === "string") {
    if (containsEnvRef(value)) {
      refs.set(path, value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectEnvRefs(value[i], `${path}[${i}]`, refs);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      collectEnvRefs(val, childPath, refs);
    }
  }
}

export function collectConfigEnvRefs(obj: unknown): Map<string, string> {
  const refs = new Map<string, string>();
  collectEnvRefs(obj, "", refs);
  return refs;
}

/**
 * Restores `${VAR}` references in a config object that is about to be written
 * to disk. For each path where the original config had a `${VAR}` reference,
 * if the expanded value in the current config matches the env var's current
 * value, the original `${VAR}` template string is restored.
 *
 * This prevents `writeConfigFile` from persisting expanded secrets.
 */
function restoreRefs(
  value: unknown,
  path: string,
  refs: Map<string, string>,
  env: NodeJS.ProcessEnv,
): unknown {
  if (typeof value === "string") {
    const original = refs.get(path);
    if (original) {
      // Check that every env var in the original template still matches
      // the current env. If so, restore the template.
      const expanded = substituteString(original, env, path);
      if (expanded === value) {
        return original;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => restoreRefs(item, `${path}[${index}]`, refs, env));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = restoreRefs(val, childPath, refs, env);
    }
    return result;
  }

  return value;
}

/**
 * Restores `${VAR}` references in a config object before writing to disk.
 *
 * @param obj - The config object with expanded values (about to be written)
 * @param refs - Map of config paths → original `${VAR}` template strings
 *               (obtained from `collectConfigEnvRefs` on the raw parsed config)
 * @param env - Environment variables (defaults to process.env)
 * @returns The config object with `${VAR}` references restored where values match
 */
export function restoreConfigEnvVarRefs(
  obj: unknown,
  refs: Map<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (refs.size === 0) {
    return obj;
  }
  return restoreRefs(obj, "", refs, env);
}
