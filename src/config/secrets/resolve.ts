/**
 * Secret reference resolution for config values.
 *
 * Supports `$secret{SECRET_NAME}` syntax in string values, resolved at config load time
 * via the configured secrets provider.
 * - Escape with `$$secret{...}` to output literal `$secret{...}`
 * - Missing secrets throw `MissingSecretError` with context
 * - The `secrets` config block itself is excluded from resolution (avoids circular deps)
 *
 * @example
 * ```json5
 * {
 *   channels: {
 *     slack: {
 *       botToken: "$secret{openclaw-slack-bot-token}"
 *     }
 *   },
 *   secrets: {
 *     provider: "gcp",
 *     gcp: { project: "my-project" }
 *   }
 * }
 * ```
 */

import type { SecretsProvider } from "./provider.js";
import type { SecretsConfig } from "./types.js";
import { createAwsSecretsProvider } from "./aws.js";
import { createBitwardenSecretsProvider } from "./bitwarden.js";
import { createDopplerSecretsProvider } from "./doppler.js";
import { createEnvSecretsProvider } from "./env.js";
import { createGcpSecretsProvider } from "./gcp.js";
import { createKeyringSecretsProvider } from "./keyring.js";
import { createOnePasswordSecretsProvider } from "./onepassword.js";
import { defaultResolveAll } from "./provider.js";
import { createVaultSecretsProvider } from "./vault.js";

/** Pattern for valid secret names: alphanumeric, hyphens, underscores, dots. */
const SECRET_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Config keys to skip during secret resolution (avoids circular deps). */
const DEFAULT_SKIP_KEYS: ReadonlySet<string> = new Set(["secrets"]);

export class MissingSecretError extends Error {
  constructor(
    public readonly secretName: string,
    public readonly configPath: string,
  ) {
    super(`Missing secret "${secretName}" referenced at config path: ${configPath}`);
    this.name = "MissingSecretError";
  }
}

export class SecretsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsProviderError";
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
 * Parse a string into a sequence of tokens representing literal text,
 * `$secret{NAME}` references, and `$$secret{NAME}` escape sequences.
 *
 * Shared between collect and substitute phases to ensure consistent handling.
 */
type SecretToken =
  | { type: "literal"; text: string }
  | { type: "ref"; name: string }
  | { type: "escape"; name: string };

function tokenizeSecretString(value: string): SecretToken[] {
  const tokens: SecretToken[] = [];
  let i = 0;

  while (i < value.length) {
    const char = value[i];
    if (char !== "$") {
      // Scan forward for the next '$' to batch literal chars
      let j = i + 1;
      while (j < value.length && value[j] !== "$") {
        j++;
      }
      tokens.push({ type: "literal", text: value.slice(i, j) });
      i = j;
      continue;
    }

    // Check for $$secret{...} escape
    if (value.startsWith("$$secret{", i)) {
      const start = i + 9; // after "$$secret{"
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const name = value.slice(start, end);
        if (SECRET_NAME_PATTERN.test(name)) {
          tokens.push({ type: "escape", name });
          i = end + 1;
          continue;
        }
      }
    }

    // Check for $secret{...} substitution
    if (value.startsWith("$secret{", i)) {
      const start = i + 8; // after "$secret{"
      const end = value.indexOf("}", start);
      if (end !== -1) {
        const name = value.slice(start, end);
        if (SECRET_NAME_PATTERN.test(name)) {
          tokens.push({ type: "ref", name });
          i = end + 1;
          continue;
        }
      }
    }

    tokens.push({ type: "literal", text: char });
    i++;
  }

  return tokens;
}

/**
 * Collect all `$secret{NAME}` references from a config tree.
 * Skips the `secrets` key at the root level to avoid circular deps.
 */
function collectSecretRefs(
  value: unknown,
  path: string,
  skipKeys: Set<string>,
  refs: Map<string, string[]>,
): void {
  if (typeof value === "string") {
    if (!value.includes("$secret{")) {
      return;
    }
    for (const token of tokenizeSecretString(value)) {
      if (token.type === "ref") {
        const existing = refs.get(token.name);
        if (existing) {
          existing.push(path);
        } else {
          refs.set(token.name, [path]);
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectSecretRefs(value[i], `${path}[${i}]`, skipKeys, refs);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (path === "" && skipKeys.has(key)) {
        continue;
      }
      const childPath = path ? `${path}.${key}` : key;
      collectSecretRefs(val, childPath, skipKeys, refs);
    }
  }
}

/**
 * Replace `$secret{NAME}` references in a string with resolved values.
 * Handles escaping: `$$secret{NAME}` -> `$secret{NAME}`.
 */
function substituteSecretString(
  value: string,
  resolved: Map<string, string>,
  configPath: string,
): string {
  if (!value.includes("$secret{")) {
    return value;
  }

  const chunks: string[] = [];
  for (const token of tokenizeSecretString(value)) {
    switch (token.type) {
      case "literal":
        chunks.push(token.text);
        break;
      case "escape":
        chunks.push(`$secret{${token.name}}`);
        break;
      case "ref": {
        const secretValue = resolved.get(token.name);
        if (secretValue === undefined) {
          throw new MissingSecretError(token.name, configPath);
        }
        chunks.push(secretValue);
        break;
      }
    }
  }
  return chunks.join("");
}

/**
 * Walk the config tree and substitute resolved secrets.
 * Skips the `secrets` key at root level.
 */
function substituteSecrets(
  value: unknown,
  resolved: Map<string, string>,
  path: string,
  skipKeys: Set<string>,
): unknown {
  if (typeof value === "string") {
    return substituteSecretString(value, resolved, path);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      substituteSecrets(item, resolved, `${path}[${index}]`, skipKeys),
    );
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (path === "" && skipKeys.has(key)) {
        result[key] = val;
        continue;
      }
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteSecrets(val, resolved, childPath, skipKeys);
    }
    return result;
  }

  return value;
}

/**
 * Create a secrets provider from the config.
 */
function createProvider(config: SecretsConfig, env?: NodeJS.ProcessEnv): SecretsProvider {
  switch (config.provider) {
    case "gcp":
      return createGcpSecretsProvider(config.gcp);
    case "env":
      return createEnvSecretsProvider(env);
    case "aws":
      return createAwsSecretsProvider(config.aws);
    case "keyring":
      return createKeyringSecretsProvider(config.keyring);
    case "1password":
      return createOnePasswordSecretsProvider();
    case "doppler":
      return createDopplerSecretsProvider(config.doppler);
    case "bitwarden":
      return createBitwardenSecretsProvider();
    case "vault":
      return createVaultSecretsProvider(config.vault);
    default:
      throw new SecretsProviderError(
        `Unknown secrets provider: "${config.provider}". Supported: gcp, env, keyring. Stubs available: aws, 1password, doppler, bitwarden, vault`,
      );
  }
}

/**
 * Detect any unresolved `$secret{...}` references in a config tree.
 * Returns the list of `$secret{...}` patterns found (e.g. `["$secret{MY_KEY}"]`).
 * Useful for sync code paths that cannot resolve secrets.
 */
export function detectUnresolvedSecretRefs(
  config: unknown,
  skipKeys: ReadonlySet<string> = DEFAULT_SKIP_KEYS,
): string[] {
  const refs: string[] = [];
  walk(config, "");
  return refs;

  function walk(value: unknown, parentKey: string): void {
    if (typeof value === "string") {
      if (!value.includes("$secret{")) {
        return;
      }
      for (const token of tokenizeSecretString(value)) {
        if (token.type === "ref") {
          refs.push(`$secret{${token.name}}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, parentKey);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, val] of Object.entries(value)) {
        // Skip the secrets config block at root level (same as collectSecretRefs)
        if (parentKey === "" && skipKeys.has(key)) {
          continue;
        }
        walk(val, key);
      }
    }
  }
}

/**
 * Resolves `$secret{SECRET_NAME}` references in config values using the
 * configured secrets provider.
 *
 * @param obj - The parsed config object (after env-var substitution)
 * @param env - Environment variables (passed to env provider)
 * @returns The config object with secrets substituted
 * @throws {MissingSecretError} If a referenced secret cannot be resolved
 * @throws {SecretsProviderError} If the provider is not configured or fails
 */
export async function resolveConfigSecrets(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (!isPlainObject(obj)) {
    return obj;
  }

  // Extract secrets config
  const secretsConfig = obj.secrets as SecretsConfig | undefined;
  if (!secretsConfig?.provider) {
    // No provider configured — check if there are any secret refs that would go unresolved
    const refs = new Map<string, string[]>();
    collectSecretRefs(obj, "", new Set(["secrets"]), refs);
    if (refs.size > 0) {
      const first = refs.entries().next().value;
      if (first) {
        throw new SecretsProviderError(
          `Found $secret{${first[0]}} reference at "${first[1][0]}" but no secrets.provider is configured`,
        );
      }
    }
    // Still run substitution to handle $$secret{} escape sequences
    return substituteSecrets(obj, new Map(), "", new Set(["secrets"]));
  }

  const skipKeys = new Set(["secrets"]);

  // Collect all secret references
  const refs = new Map<string, string[]>();
  collectSecretRefs(obj, "", skipKeys, refs);

  let resolved: Map<string, string>;

  if (refs.size === 0) {
    resolved = new Map();
  } else {
    // Create provider, resolve all secrets, and dispose when done
    const provider = createProvider(secretsConfig, env);
    try {
      const secretNames = Array.from(refs.keys());

      if (provider.resolveAll) {
        resolved = await provider.resolveAll(secretNames);
      } else {
        resolved = await defaultResolveAll(provider, secretNames);
      }

      // Verify all secrets were resolved
      for (const name of secretNames) {
        if (!resolved.has(name)) {
          const paths = refs.get(name)!;
          throw new MissingSecretError(name, paths[0]);
        }
      }
    } finally {
      // Always dispose provider (e.g., lock macOS keychain).
      // Best-effort: don't let a dispose error mask the primary error.
      try {
        await provider.dispose?.();
      } catch {
        // Swallow dispose errors — the primary error (if any) is more important.
      }
    }
  }

  // Substitute (also handles $$secret{} escaping)
  return substituteSecrets(obj, resolved, "", skipKeys);
}
