/**
 * Environment variable substitution for config values.
 *
 * Supports `${VAR_NAME}` and `${VAR_NAME:-default}` syntax in string values,
 * substituted at config load time.
 * - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 * - `${VAR:-fallback}` uses `fallback` when the var is unset or empty
 * - Escape with `$${}` to output literal `${}`
 * - Missing env vars (without defaults) throw `MissingEnvVarError` with context
 *
 * @example
 * ```json5
 * {
 *   models: {
 *     providers: {
 *       "custom-gateway": {
 *         apiKey: "${CUSTOM_API_KEY}",
 *         baseUrl: "${CUSTOM_BASE_URL:-https://api.example.com/v1}"
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

// For "escaped" tokens, `name` holds the full inner content including any `:-…` suffix (e.g. "VAR:-fallback").
// For "substitution" tokens, `name` holds only the variable name (e.g. "VAR").
type EnvToken =
  | { kind: "escaped"; name: string; end: number }
  | { kind: "substitution"; name: string; defaultValue?: string; end: number };

function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") {
    return null;
  }

  const next = value[index + 1];
  const afterNext = value[index + 2];

  // Escaped: $${VAR} -> ${VAR} or $${VAR:-default} -> ${VAR:-default}
  if (next === "$" && afterNext === "{") {
    const start = index + 3;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const inner = value.slice(start, end);
      const sepIdx = inner.indexOf(":-");
      const rawName = sepIdx !== -1 ? inner.slice(0, sepIdx) : inner;
      if (ENV_VAR_NAME_PATTERN.test(rawName)) {
        return { kind: "escaped", name: inner, end };
      }
    }
  }

  // Substitution: ${VAR} or ${VAR:-default} -> value
  if (next === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const inner = value.slice(start, end);
      const sepIndex = inner.indexOf(":-");
      if (sepIndex !== -1) {
        const name = inner.slice(0, sepIndex);
        if (ENV_VAR_NAME_PATTERN.test(name)) {
          const defaultValue = inner.slice(sepIndex + 2);
          return { kind: "substitution", name, defaultValue, end };
        }
      }
      if (ENV_VAR_NAME_PATTERN.test(inner)) {
        return { kind: "substitution", name: inner, end };
      }
    }
  }

  return null;
}

export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

export type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
};

function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
  opts?: SubstituteOptions,
): string {
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

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      chunks.push(`\${${token.name}}`);
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      const envValue = env[token.name];
      if (envValue === undefined || envValue === "") {
        if (token.defaultValue !== undefined) {
          chunks.push(token.defaultValue);
          i = token.end;
          continue;
        }
        if (opts?.onMissing) {
          opts.onMissing({ varName: token.name, configPath });
          // onMissing is only reachable when token.defaultValue is undefined (no default),
          // so reconstructing ${token.name} without a default suffix is always accurate.
          // Preserve the original placeholder so the value is visibly unresolved.
          chunks.push(`\${${token.name}}`);
          i = token.end;
          continue;
        }
        throw new MissingEnvVarError(token.name, configPath);
      }
      chunks.push(envValue);
      i = token.end;
      continue;
    }

    // Leave untouched if not a recognized pattern
    chunks.push(char);
  }

  return chunks.join("");
}

export function containsEnvVarReference(value: string): boolean {
  if (!value.includes("$")) {
    return false;
  }

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "$") {
      continue;
    }

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      return true;
    }
  }

  return false;
}

function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, path, opts);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteAny(val, env, childPath, opts);
    }
    return result;
  }

  // Primitives (number, boolean, null) pass through unchanged
  return value;
}

/**
 * Resolves `${VAR_NAME}` and `${VAR_NAME:-default}` environment variable references in config values.
 *
 * @param obj - The parsed config object (after JSON5 parse and $include resolution)
 * @param env - Environment variables to use for substitution (defaults to process.env)
 * @param opts - Options: `onMissing` callback to collect warnings instead of throwing.
 * @returns The config object with env vars substituted
 * @throws {MissingEnvVarError} If a referenced env var is not set or empty (unless `onMissing` is set)
 */
export function resolveConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts?: SubstituteOptions,
): unknown {
  return substituteAny(obj, env, "", opts);
}
