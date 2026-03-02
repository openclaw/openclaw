/**
 * Environment variable substitution for config values.
 *
 * Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
 * Supports `${pass:path/to/secret}` and `${gopass:path/to/secret}` secret lookups.
 * - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
 * - Escape with `$${}` to output literal `${}`
 * - Missing env vars throw `MissingEnvVarError` with context
 * - Missing secret refs throw `MissingSecretError` with context
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

import { execFileSync } from "node:child_process";
// Pattern for valid uppercase env var names: starts with letter or underscore,
// followed by letters, numbers, or underscores (all uppercase)
import { isPlainObject } from "../utils.js";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_COMMAND_TIMEOUT_MS_DEFAULT = 5_000;

type SecretBackend = "pass" | "gopass";

export type SecretCommandRunner = (command: string, args: string[], timeoutMs: number) => string;

export type ConfigEnvSubstitutionOptions = {
  secretCommandRunner?: SecretCommandRunner;
  secretCommandTimeoutMs?: number;
};

type SecretReference = {
  backend: SecretBackend;
  secretPath: string;
};

type ParsedReference =
  | { kind: "env"; name: string }
  | { kind: "secret"; reference: SecretReference }
  | { kind: "invalid-secret"; raw: string };

type SubstitutionContext = {
  env: NodeJS.ProcessEnv;
  secretCommandRunner: SecretCommandRunner;
  secretCommandTimeoutMs: number;
  secretCache: Map<string, string>;
};

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
    public readonly backend: SecretBackend,
    public readonly secretPath: string,
    public readonly configPath: string,
    details?: string,
  ) {
    const suffix = details ? ` (${details})` : "";
    super(
      `Missing secret "${backend}:${secretPath}" referenced at config path: ${configPath}${suffix}`,
    );
    this.name = "MissingSecretError";
  }
}

export class InvalidSecretReferenceError extends Error {
  constructor(
    public readonly reference: string,
    public readonly configPath: string,
  ) {
    super(`Invalid secret reference "${reference}" at config path: ${configPath}`);
    this.name = "InvalidSecretReferenceError";
  }
}

type EnvToken =
  | { kind: "escaped"; parsed: ParsedReference; raw: string; end: number }
  | { kind: "substitution"; parsed: ParsedReference; raw: string; end: number };

function resolveSecretTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return SECRET_COMMAND_TIMEOUT_MS_DEFAULT;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function isSecretBackend(value: string): value is SecretBackend {
  return value === "pass" || value === "gopass";
}

function isValidSecretPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  const segments = value.split("/");
  if (segments.length === 0) {
    return false;
  }
  return segments.every((segment) => {
    if (segment === "." || segment === "..") {
      return false;
    }
    return SECRET_PATH_SEGMENT_PATTERN.test(segment);
  });
}

function parseReference(raw: string): ParsedReference | null {
  if (ENV_VAR_NAME_PATTERN.test(raw)) {
    return { kind: "env", name: raw };
  }
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const backend = raw.slice(0, separatorIndex);
  const secretPath = raw.slice(separatorIndex + 1);
  if (!isSecretBackend(backend)) {
    return null;
  }
  if (!isValidSecretPath(secretPath)) {
    return { kind: "invalid-secret", raw };
  }
  return { kind: "secret", reference: { backend, secretPath } };
}

function defaultSecretCommandRunner(command: string, args: string[], timeoutMs: number): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function isCommandNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown };
  return candidate.code === "ENOENT";
}

function formatSecretLookupError(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message ? message : undefined;
  }
  return undefined;
}

function normalizeSecretOutput(value: string): string {
  return value.replace(/\r?\n+$/, "");
}

function buildSecretCommandAttempts(
  reference: SecretReference,
): Array<{ cmd: string; args: string[] }> {
  if (reference.backend === "pass") {
    return [
      { cmd: "pass", args: ["show", reference.secretPath] },
      { cmd: "gopass", args: ["show", "-o", reference.secretPath] },
    ];
  }
  return [
    { cmd: "gopass", args: ["show", "-o", reference.secretPath] },
    { cmd: "pass", args: ["show", reference.secretPath] },
  ];
}

function resolveSecretValue(
  reference: SecretReference,
  configPath: string,
  context: SubstitutionContext,
): string {
  const cacheKey = `${reference.backend}:${reference.secretPath}`;
  const cached = context.secretCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const attempts = buildSecretCommandAttempts(reference);
  let lastError: unknown;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const raw = context.secretCommandRunner(
        attempt.cmd,
        attempt.args,
        context.secretCommandTimeoutMs,
      );
      const normalized = normalizeSecretOutput(raw);
      if (normalized === "") {
        throw new Error("resolved to empty output");
      }
      context.secretCache.set(cacheKey, normalized);
      return normalized;
    } catch (error) {
      lastError = error;
      const hasFallback = index + 1 < attempts.length;
      if (!hasFallback) {
        break;
      }
      if (!isCommandNotFoundError(error)) {
        break;
      }
    }
  }

  throw new MissingSecretError(
    reference.backend,
    reference.secretPath,
    configPath,
    formatSecretLookupError(lastError),
  );
}

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
      const raw = value.slice(start, end);
      const parsed = parseReference(raw);
      if (parsed !== null) {
        return { kind: "escaped", parsed, raw, end };
      }
    }
  }

  // Substitution: ${VAR} -> value
  if (next === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const raw = value.slice(start, end);
      const parsed = parseReference(raw);
      if (parsed !== null) {
        return { kind: "substitution", parsed, raw, end };
      }
    }
  }

  return null;
}

function substituteString(value: string, configPath: string, context: SubstitutionContext): string {
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
      chunks.push(`\${${token.raw}}`);
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      if (token.parsed.kind === "env") {
        const envValue = context.env[token.parsed.name];
        if (envValue === undefined || envValue === "") {
          throw new MissingEnvVarError(token.parsed.name, configPath);
        }
        chunks.push(envValue);
        i = token.end;
        continue;
      }
      if (token.parsed.kind === "invalid-secret") {
        throw new InvalidSecretReferenceError(token.parsed.raw, configPath);
      }
      const secretValue = resolveSecretValue(token.parsed.reference, configPath, context);
      chunks.push(secretValue);
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

function substituteAny(value: unknown, path: string, context: SubstitutionContext): unknown {
  if (typeof value === "string") {
    return substituteString(value, path, context);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, `${path}[${index}]`, context));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteAny(val, childPath, context);
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
 * @param options - Optional secret lookup hooks and timeout controls
 * @returns The config object with env vars substituted
 * @throws {MissingEnvVarError} If a referenced env var is not set or empty
 */
export function resolveConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: ConfigEnvSubstitutionOptions = {},
): unknown {
  const context: SubstitutionContext = {
    env,
    secretCommandRunner: options.secretCommandRunner ?? defaultSecretCommandRunner,
    secretCommandTimeoutMs: resolveSecretTimeoutMs(options.secretCommandTimeoutMs),
    secretCache: new Map<string, string>(),
  };
  return substituteAny(obj, "", context);
}
