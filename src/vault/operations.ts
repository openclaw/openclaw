/**
 * Vault secret management operations.
 *
 * Provides encrypt/decrypt logic using the `age-encryption` library (X25519),
 * vault file path resolution, secret key resolution, and a provider registry
 * mapping known providers to their vault proxy ports and secret names.
 *
 * These functions are used by the CLI (`openclaw vault ...`) and are independent
 * of the running gateway process.
 */
import * as age from "age-encryption";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Provider registry — matches vault/nginx.conf.template server blocks
// ---------------------------------------------------------------------------

export type VaultProviderEntry = {
  /** Nginx proxy listen port inside the vault sidecar. */
  port: number;
  /** Environment variable name expected in vault.age (matches nginx template). */
  secretName: string;
};

/**
 * Known provider defaults. Keys are canonical provider names (lowercase).
 * Ports and secret names must match vault/nginx.conf.template server blocks
 * and vault/entrypoint.sh (validation list + envsubst variable list).
 */
export const VAULT_PROVIDER_DEFAULTS: Record<string, VaultProviderEntry> = {
  openai: { port: 8081, secretName: "OPENAI_API_KEY" },
  anthropic: { port: 8082, secretName: "ANTHROPIC_API_KEY" },
  deepgram: { port: 8083, secretName: "DEEPGRAM_API_KEY" },
  "openai-compat": { port: 8084, secretName: "OPENAI_COMPAT_API_KEY" },
  google: { port: 8085, secretName: "GEMINI_API_KEY" },
  groq: { port: 8086, secretName: "GROQ_API_KEY" },
  xai: { port: 8087, secretName: "XAI_API_KEY" },
  mistral: { port: 8088, secretName: "MISTRAL_API_KEY" },
  brave: { port: 8089, secretName: "BRAVE_API_KEY" },
  perplexity: { port: 8090, secretName: "PERPLEXITY_API_KEY" },
};

// ---------------------------------------------------------------------------
// Vault file path resolution
// ---------------------------------------------------------------------------

const DEFAULT_VAULT_FILENAME = "vault.age";

/**
 * Resolve the vault.age file path.
 *
 * Precedence:
 * 1. `OPENCLAW_VAULT_PATH` environment variable
 * 2. `vault.file` in config
 * 3. `vault.age` alongside openclaw.json
 */
export function resolveVaultFilePath(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envOverride = env.OPENCLAW_VAULT_PATH?.trim();
  if (envOverride) {
    return path.resolve(envOverride);
  }
  const configFile = cfg?.vault?.file?.trim();
  if (configFile) {
    return path.resolve(configFile);
  }
  const configPath = resolveConfigPath(env, resolveStateDir(env));
  return path.join(path.dirname(configPath), DEFAULT_VAULT_FILENAME);
}

// ---------------------------------------------------------------------------
// AGE_SECRET_KEY resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the age secret key (identity) for decryption.
 *
 * Precedence:
 * 1. `AGE_SECRET_KEY` environment variable
 * 2. Interactive stdin prompt (if TTY)
 * 3. Error with instructions
 */
export async function resolveAgeSecretKey(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdin.isTTY),
): Promise<string> {
  const envKey = env.AGE_SECRET_KEY?.trim();
  if (envKey) {
    // Clear from environment to prevent leaking to child processes
    delete env.AGE_SECRET_KEY;
    return envKey;
  }
  if (isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question("Enter AGE_SECRET_KEY (identity): ");
      const trimmed = answer.trim();
      if (trimmed) {
        return trimmed;
      }
    } finally {
      rl.close();
    }
  }
  throw new Error(
    "AGE_SECRET_KEY not available.\n" +
      "Provide it via environment variable:\n" +
      "  AGE_SECRET_KEY=<your-key> openclaw vault <command>\n" +
      "Or run in an interactive terminal for a prompt.",
  );
}

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

export type AgeKeypair = {
  /** Secret key (identity, `AGE-SECRET-KEY-1...`). */
  identity: string;
  /** Public key (recipient, `age1...`). */
  recipient: string;
};

/**
 * Generate a new age X25519 keypair.
 */
export async function generateKeypair(): Promise<AgeKeypair> {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

// ---------------------------------------------------------------------------
// Secret parsing / serialization (KEY=VALUE format)
// ---------------------------------------------------------------------------

/**
 * Parse vault secrets from plaintext KEY=VALUE format.
 * Skips blank lines and `#` comments.
 * Values may be quoted (double or single quotes are stripped).
 */
export function parseVaultSecrets(plaintext: string): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const rawLine of plaintext.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx < 1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    secrets.set(key, value);
  }
  return secrets;
}

/**
 * Serialize secrets map to KEY=VALUE format.
 */
export function serializeVaultSecrets(secrets: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of secrets) {
    lines.push(`${key}=${value}`);
  }
  // Ensure trailing newline
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypt a vault.age file and return parsed secrets.
 */
export async function decryptVault(
  vaultPath: string,
  secretKey: string,
): Promise<Map<string, string>> {
  try {
    await fs.promises.access(vaultPath);
  } catch {
    throw new Error(`Vault file not found: ${vaultPath}`);
  }
  const ciphertext = await fs.promises.readFile(vaultPath);
  const d = new age.Decrypter();
  d.addIdentity(secretKey);
  let plaintext: string;
  try {
    plaintext = await d.decrypt(ciphertext, "text");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to decrypt vault: ${msg}\n` +
        "The vault file may be corrupted, or the decryption key may be wrong.",
      { cause: err },
    );
  }
  return parseVaultSecrets(plaintext);
}

/**
 * Encrypt secrets and write to vault.age file (mode 0600).
 *
 * @param secrets - Map of secret name to value
 * @param recipient - Age public key (`age1...`)
 * @param vaultPath - Output file path
 */
export async function encryptVault(
  secrets: Map<string, string>,
  recipient: string,
  vaultPath: string,
): Promise<void> {
  const plaintext = serializeVaultSecrets(secrets);
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  const ciphertext = await e.encrypt(plaintext);

  // Atomic write: temp file + rename (cleanup temp on failure)
  const dir = path.dirname(vaultPath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${vaultPath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, ciphertext, { mode: 0o600 });
  try {
    await fs.promises.rename(tmp, vaultPath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Provider name to secret name lookup
// ---------------------------------------------------------------------------

/**
 * Look up the default secret name for a provider.
 * Returns undefined if the provider is not in the registry.
 */
export function providerSecretName(provider: string): string | undefined {
  return VAULT_PROVIDER_DEFAULTS[provider.toLowerCase()]?.secretName;
}

const VALID_HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Build the default proxy URL for a known provider.
 */
export function providerProxyUrl(provider: string, proxyHost = "vault"): string | undefined {
  const entry = VAULT_PROVIDER_DEFAULTS[provider.toLowerCase()];
  if (!entry) {
    return undefined;
  }
  if (!VALID_HOSTNAME.test(proxyHost)) {
    throw new Error(
      `Invalid proxy hostname: ${JSON.stringify(proxyHost)}\n` +
        "Hostnames must start with an alphanumeric character and contain only [a-zA-Z0-9._-].",
    );
  }
  return `http://${proxyHost}:${entry.port}`;
}

/** Build default proxy URL map for all known providers. */
export function buildDefaultProxyMap(proxyHost?: string): Record<string, string> {
  const proxies: Record<string, string> = {};
  for (const [name] of Object.entries(VAULT_PROVIDER_DEFAULTS)) {
    const url = providerProxyUrl(name, proxyHost);
    if (url) {
      proxies[name] = url;
    }
  }
  return proxies;
}

/** Find a provider entry by its secret name (reverse lookup). */
export function findProviderBySecretName(
  secretName: string,
): [string, VaultProviderEntry] | undefined {
  return Object.entries(VAULT_PROVIDER_DEFAULTS).find(
    ([, entry]) => entry.secretName === secretName,
  );
}
