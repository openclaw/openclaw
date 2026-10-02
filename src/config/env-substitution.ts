/**
 * Environment variable substitution for config values.
 *
 * Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
 * - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 * - `${VAR_NAME:-fallback}` uses `fallback` when the var is unset or empty
 * - Escape with `$${}` to output literal `${}`
 * - Missing env vars without a fallback throw `MissingEnvVarError` with context
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

import { appendConfigPathSegment } from "../shared/dot-path.js";
import { isPlainObject } from "../utils.js";
import { parseEnvTemplateSecretRef } from "./types.secrets.js";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Bare references and defaults both treat an empty environment value as missing.
const DEFAULT_VALUE_OPERATOR = ":-";

/** Error thrown when a config value references a missing or empty environment variable. */
export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

/** One recognized `${VAR}` / `${VAR:-fallback}` placeholder, without its position. */
export type EnvTemplateToken = {
  kind: "escaped" | "substitution";
  name: string;
  /** Authored fallback text, or `undefined` for a bare reference. `""` is a real empty fallback. */
  defaultValue?: string;
};

type EnvToken = EnvTemplateToken & { end: number };

// Nested fallbacks stay literal; their inner references are scanned independently.
function parseEnvTokenBody(body: string): Omit<EnvTemplateToken, "kind"> | null {
  if (ENV_VAR_NAME_PATTERN.test(body)) {
    return { name: body };
  }

  const operatorIndex = body.indexOf(DEFAULT_VALUE_OPERATOR);
  if (operatorIndex === -1) {
    return null;
  }

  const name = body.slice(0, operatorIndex);
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    return null;
  }

  const defaultValue = body.slice(operatorIndex + DEFAULT_VALUE_OPERATOR.length);
  if (defaultValue.includes("$") || defaultValue.includes("{")) {
    return null;
  }
  return { name, defaultValue };
}

/** Rebuilds the authored placeholder text for a parsed token. */
function renderEnvTemplateToken(token: EnvTemplateToken): string {
  return token.defaultValue === undefined
    ? `\${${token.name}}`
    : `\${${token.name}${DEFAULT_VALUE_OPERATOR}${token.defaultValue}}`;
}

function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") {
    return null;
  }

  // Parse escaped placeholders first so "$${VAR}" never resolves from env.
  const escaped = value[index + 1] === "$" && value[index + 2] === "{";
  if (escaped || value[index + 1] === "{") {
    const start = index + (escaped ? 3 : 2);
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const body = parseEnvTokenBody(value.slice(start, end));
      if (body) {
        return { kind: escaped ? "escaped" : "substitution", ...body, end };
      }
    }
  }

  return null;
}

/** Shares the substitution grammar with write-back preservation, in authoring order. */
export function scanEnvTemplateTokens(value: string): EnvTemplateToken[] {
  return Array.from(iterateEnvTemplateTokens(value), (token) => ({
    kind: token.kind,
    name: token.name,
    defaultValue: token.defaultValue,
  }));
}

function* iterateEnvTemplateTokens(value: string): Generator<EnvToken & { start: number }> {
  for (let index = value.indexOf("$"); index !== -1; index = value.indexOf("$", index + 1)) {
    const token = parseEnvTokenAt(value, index);
    if (token) {
      yield { ...token, start: index };
      index = token.end;
    }
  }
}

/** Missing environment variable warning emitted when substitution is configured to continue. */
export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
  /** Records exact env SecretRef shorthand that substitution did not materialize. */
  onPendingEnvSecretRef?: (id: string, configPath: string) => void;
  /** Records the source of an exact env SecretRef shorthand that substitution materialized. */
  onResolvedEnvSecretRef?: (id: string, configPath: string) => void;
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

  const authoredRef = parseEnvTemplateSecretRef(value);
  if (authoredRef && !containsEnvVarReference(value)) {
    opts?.onPendingEnvSecretRef?.(authoredRef.id, configPath);
  }
  const chunks: string[] = [];
  let end = 0;
  for (const token of iterateEnvTemplateTokens(value)) {
    chunks.push(value.slice(end, token.start));
    end = token.end + 1;
    if (token.kind === "escaped") {
      chunks.push(renderEnvTemplateToken(token));
      continue;
    }
    const envValue = env[token.name];
    if (envValue === undefined || envValue === "") {
      if (token.defaultValue !== undefined) {
        // An authored fallback resolves the reference without a missing or pending signal.
        chunks.push(token.defaultValue);
        continue;
      }
      if (opts?.onMissing) {
        opts.onMissing({ varName: token.name, configPath });
        if (authoredRef?.id === token.name) {
          opts.onPendingEnvSecretRef?.(token.name, configPath);
        }
        // Preserve the original placeholder so the value is visibly unresolved.
        chunks.push(renderEnvTemplateToken(token));
        continue;
      }
      throw new MissingEnvVarError(token.name, configPath);
    }
    if (authoredRef?.id === token.name) {
      opts?.onResolvedEnvSecretRef?.(token.name, configPath);
    }
    chunks.push(envValue);
  }
  chunks.push(value.slice(end));

  return chunks.join("");
}

/** Detects unescaped `${VAR}` references without treating escaped `$${VAR}` as references. */
export function containsEnvVarReference(value: string): boolean {
  for (const token of iterateEnvTemplateTokens(value)) {
    if (token.kind === "substitution") {
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
  // Resume one parent at a time so callbacks retain recursive depth-first order
  // without consuming the engine stack for deeply nested replacement values.
  const pending: Array<() => boolean> = [];
  const visit = (current: unknown, currentPath: string): unknown => {
    if (typeof current === "string") {
      return substituteString(current, env, currentPath, opts);
    }
    if (Array.isArray(current)) {
      const length = current.length;
      const result: unknown[] = [];
      result.length = length;
      let index = 0;
      pending.push(() => {
        while (index < length) {
          const key = index++;
          if (key in current) {
            result[key] = visit(current[key], `${currentPath}[${key}]`);
            return true;
          }
        }
        return false;
      });
      return result;
    }
    if (isPlainObject(current)) {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(current)[Symbol.iterator]();
      pending.push(() => {
        const entry = entries.next();
        if (entry.done) {
          return false;
        }
        const [key, child] = entry.value;
        result[key] = visit(child, appendConfigPathSegment(currentPath, key));
        return true;
      });
      return result;
    }
    return current;
  };
  const result = visit(value, path);
  for (let next = pending.at(-1); next; next = pending.at(-1)) {
    if (!next()) {
      pending.pop();
    }
  }
  return result;
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
