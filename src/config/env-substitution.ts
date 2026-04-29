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

/** Matches a string whose entire value (ignoring whitespace) is one `${VAR}` reference. */
const SINGLE_VAR_REFERENCE = /^\s*\$\{[A-Z_][A-Z0-9_]*\}\s*$/;

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

type EnvToken =
  | { kind: "escaped"; name: string; end: number }
  | { kind: "substitution"; name: string; end: number };

function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") {
    return null;
  }

  const next = value[index + 1];
  const afterNext = value[index + 2];

  // Escaped: $${VAR} -> ${VAR}
  if (next === "$" && afterNext === "{") {
    const start = index + 3;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "escaped", name, end };
      }
    }
  }

  // Substitution: ${VAR} -> value
  if (next === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "substitution", name, end };
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
        if (opts?.onMissing) {
          opts.onMissing({ varName: token.name, configPath });
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

/**
 * Parse an env var value as a JSON array of strings. Returns the parsed array
 * when the value is a well-formed `["a", "b"]` literal, otherwise `null`. Array
 * items must all be strings — objects/numbers/nested arrays are rejected so the
 * resulting config type stays a plain string[].
 */
function tryParseJsonStringArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return null;
  }
  return parsed;
}

function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") {
    const substituted = substituteString(value, env, path, opts);
    // Opt-in array coercion: when a config value is exactly one `${VAR}` reference
    // (no surrounding text) and the env var holds a JSON string array, coerce the
    // result to a real array. This lets operators inject list-valued config (for
    // example, allowlists) via a single env var in container/K8s deployments where
    // array-typed env vars are inconvenient.
    if (SINGLE_VAR_REFERENCE.test(value)) {
      const asArray = tryParseJsonStringArray(substituted);
      if (asArray !== null) {
        return asArray;
      }
    }
    return substituted;
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
 * Resolves `${VAR_NAME}` environment variable references in config values.
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
