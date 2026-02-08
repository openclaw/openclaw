/**
 * Environment variable and secret substitution for config values.
 *
 * Supports two syntaxes in string values, substituted at config load time:
 *
 * 1. Environment variables: `${VAR_NAME}`
 *    - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 *    - Escape with `$${}` to output literal `${}`
 *    - Missing env vars throw `MissingEnvVarError` with context
 *
 * 2. Pass (password-store) secrets: `${pass:path/to/secret}`
 *    - Calls `pass show path/to/secret` to retrieve the value
 *    - Missing or failed lookups throw `MissingSecretError`
 *    - Requires `pass` to be installed and GPG configured
 *
 * @example
 * ```json5
 * {
 *   models: {
 *     providers: {
 *       "vercel-gateway": {
 *         apiKey: "${VERCEL_GATEWAY_API_KEY}"  // from env
 *       }
 *     }
 *   },
 *   channels: {
 *     telegram: {
 *       botToken: "${pass:openclaw/telegram/bot_token}"  // from pass
 *     }
 *   }
 * }
 * ```
 */

import { execFileSync } from "node:child_process";

// Pattern for valid uppercase env var names: starts with letter or underscore,
// followed by letters, numbers, or underscores (all uppercase)
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Pattern for pass paths: alphanumeric, underscores, hyphens, slashes
const PASS_PATH_PATTERN = /^[a-zA-Z0-9_\-\/]+$/;

// Cache for pass lookups to avoid repeated calls
const passCache = new Map<string, string>();

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

export class MissingSecretError extends Error {
  constructor(
    public readonly secretPath: string,
    public readonly configPath: string,
    public readonly reason?: string,
  ) {
    const reasonStr = reason ? ` (${reason})` : "";
    super(`Failed to retrieve secret "${secretPath}" at config path: ${configPath}${reasonStr}`);
    this.name = "MissingSecretError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Retrieve a secret from pass (password-store).
 * Results are cached for the lifetime of the process.
 */
function getPassSecret(secretPath: string, configPath: string): string {
  // Check cache first
  const cached = passCache.get(secretPath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = execFileSync("pass", ["show", secretPath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const value = result.trim();
    if (!value) {
      throw new MissingSecretError(secretPath, configPath, "empty value");
    }
    passCache.set(secretPath, value);
    return value;
  } catch (err) {
    if (err instanceof MissingSecretError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not in the password store")) {
      throw new MissingSecretError(secretPath, configPath, "not found in password store");
    }
    if (message.includes("gpg")) {
      throw new MissingSecretError(secretPath, configPath, "GPG error - check gpg-agent");
    }
    throw new MissingSecretError(secretPath, configPath, message);
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

    // Escaped: $${VAR} or $${pass:path} -> ${VAR} or ${pass:path}
    if (next === "$" && afterNext === "{") {
      const start = i + 3;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const content = value.slice(start, end);
        // Allow escaping env vars (${VAR}) or pass refs (${pass:path})
        if (
          ENV_VAR_NAME_PATTERN.test(content) ||
          (content.startsWith("pass:") && PASS_PATH_PATTERN.test(content.slice(5)))
        ) {
          chunks.push(`\${${content}}`);
          i = end;
          continue;
        }
      }
    }

    // Pass substitution: ${pass:path/to/secret} -> value from pass
    if (next === "{") {
      const start = i + 2;
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const content = value.slice(start, end);

        // Check for pass: prefix
        if (content.startsWith("pass:")) {
          const passPath = content.slice(5); // Remove "pass:" prefix
          if (PASS_PATH_PATTERN.test(passPath)) {
            const secretValue = getPassSecret(passPath, configPath);
            chunks.push(secretValue);
            i = end;
            continue;
          }
        }

        // Standard env var substitution: ${VAR} -> value
        if (ENV_VAR_NAME_PATTERN.test(content)) {
          const envValue = env[content];
          if (envValue === undefined || envValue === "") {
            throw new MissingEnvVarError(content, configPath);
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
 * Clears the pass secret cache. Useful for testing or when secrets may have changed.
 */
export function clearPassCache(): void {
  passCache.clear();
}

/**
 * Resolves `${VAR_NAME}` environment variable references and
 * `${pass:path}` password-store references in config values.
 *
 * @param obj - The parsed config object (after JSON5 parse and $include resolution)
 * @param env - Environment variables to use for substitution (defaults to process.env)
 * @returns The config object with env vars and secrets substituted
 * @throws {MissingEnvVarError} If a referenced env var is not set or empty
 * @throws {MissingSecretError} If a pass secret cannot be retrieved
 */
export function resolveConfigEnvVars(obj: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  return substituteAny(obj, env, "");
}
