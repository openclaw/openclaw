/**
 * `openclaw vault` CLI — manage age-encrypted secrets for the vault proxy.
 *
 * Subcommands:
 *   init     — generate keypair, create vault.age, store publicKey in config
 *   status   — show vault state (no decryption needed)
 *   add      — add or update a secret in vault.age
 *   remove   — remove a secret from vault.age
 *   list     — list secret names (optionally reveal partial values)
 *   migrate  — migrate plaintext apiKey values from config into vault.age
 */
import type { Command } from "commander";
import fs from "node:fs";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import readline from "node:readline/promises";
import { VAULT_PROXY_PLACEHOLDER_KEY } from "../agents/model-auth.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import {
  buildDefaultProxyMap,
  decryptVault,
  encryptVault,
  findProviderBySecretName,
  generateKeypair,
  providerProxyUrl,
  providerSecretName,
  resolveAgeSecretKey,
  resolveVaultFilePath,
} from "../vault/operations.js";
import { runCommandWithRuntime } from "./cli-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the secret value from CLI argument, stdin pipe, or interactive prompt.
 * Avoids exposing secrets in process arguments when using --stdin or prompt.
 */
async function resolveSecretValue(value: string | undefined, useStdin: boolean): Promise<string> {
  if (value !== undefined) {
    return value;
  }
  if (useStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdinStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const result = Buffer.concat(chunks).toString("utf-8").trim();
    if (!result) {
      throw new Error("Empty value received from stdin.");
    }
    return result;
  }
  if (stdinStream.isTTY) {
    const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
    try {
      const answer = await rl.question("Enter secret value: ");
      const trimmed = answer.trim();
      if (!trimmed) {
        throw new Error("Empty value provided.");
      }
      return trimmed;
    } finally {
      rl.close();
    }
  }
  throw new Error(
    "No secret value provided.\n" +
      "Provide it as an argument, via --stdin, or run in a terminal for a prompt.",
  );
}

const VALID_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

function validateSecretName(name: string): void {
  if (!VALID_SECRET_NAME.test(name)) {
    throw new Error(
      `Invalid secret name: ${JSON.stringify(name)}\n` +
        "Secret names must match [A-Z][A-Z0-9_]* (e.g. OPENAI_API_KEY).",
    );
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  const visible = 4;
  return value.slice(0, visible) + "*".repeat(value.length - visible * 2) + value.slice(-visible);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerVaultCli(program: Command) {
  const vault = program.command("vault").description("Vault secret management (age encryption)");

  // ---- init ----------------------------------------------------------------
  vault
    .command("init")
    .description("Initialize vault: generate keypair, create vault.age, update config")
    .option("--force", "Overwrite existing vault.age and keypair", false)
    .option("--proxy-host <host>", "Proxy hostname for auto-configured URLs", "vault")
    .action(async (opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);

        if (fs.existsSync(vaultPath) && !opts.force) {
          throw new Error(`Vault file already exists: ${vaultPath}\nUse --force to overwrite.`);
        }

        const keypair = await generateKeypair();

        // Create empty vault.age encrypted with the new public key
        await encryptVault(new Map(), keypair.recipient, vaultPath);

        // Build default proxy mappings from provider registry
        const defaultProxies = buildDefaultProxyMap(opts.proxyHost);

        // Update config with vault settings + default proxy mappings
        const snapshot = await readConfigFileSnapshot();
        const next = {
          ...snapshot.config,
          vault: {
            ...snapshot.config.vault,
            enabled: true,
            publicKey: keypair.recipient,
            proxies: {
              ...defaultProxies,
              ...snapshot.config.vault?.proxies, // preserve user overrides
            },
          },
        };
        await writeConfigFile(next);

        defaultRuntime.log(theme.heading("Vault initialized"));
        defaultRuntime.log("");
        defaultRuntime.log(`Vault file: ${vaultPath}`);
        defaultRuntime.log(`Public key: ${keypair.recipient}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          theme.warn("Save this secret key securely. It will not be shown again:"),
        );
        defaultRuntime.log("");
        defaultRuntime.log(`  ${keypair.identity}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          theme.muted("Store it in a password manager (KeePass, 1Password, etc.)."),
        );
        defaultRuntime.log(
          theme.muted("You will need it for: vault add, vault remove, vault list, vault migrate."),
        );
        defaultRuntime.log(
          theme.muted("Provide it via: AGE_SECRET_KEY=<key> openclaw vault <command>"),
        );
      }),
    );

  // ---- status --------------------------------------------------------------
  vault
    .command("status")
    .description("Show vault configuration and file state (no decryption needed)")
    .action(async () =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);
        const vaultExists = fs.existsSync(vaultPath);

        const rows: Array<{ Key: string; Value: string }> = [
          { Key: "Enabled", Value: cfg.vault?.enabled ? "yes" : "no" },
          { Key: "Vault file", Value: vaultPath },
          { Key: "File exists", Value: vaultExists ? "yes" : "no" },
        ];

        if (vaultExists) {
          const stat = fs.statSync(vaultPath);
          rows.push({ Key: "File size", Value: `${stat.size} bytes` });
        }

        rows.push({
          Key: "Public key",
          Value: cfg.vault?.publicKey ?? "(not set)",
        });

        const proxies = cfg.vault?.proxies;
        if (proxies && Object.keys(proxies).length > 0) {
          rows.push({ Key: "Proxy mappings", Value: "" });
          for (const [provider, url] of Object.entries(proxies)) {
            rows.push({ Key: `  ${provider}`, Value: url });
          }
        } else {
          rows.push({ Key: "Proxy mappings", Value: "(none)" });
        }

        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        defaultRuntime.log(theme.heading("Vault status"));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Key", header: "Property", minWidth: 18 },
              { key: "Value", header: "Value", minWidth: 24, flex: true },
            ],
            rows,
          }).trimEnd(),
        );
      }),
    );

  // ---- add -----------------------------------------------------------------
  vault
    .command("add <name> [value]")
    .description("Add or update a secret in vault.age")
    .option("--stdin", "Read secret value from stdin (avoids shell history exposure)")
    .option("--no-proxy", "Skip automatic proxy configuration for known providers")
    .option("--proxy-host <host>", "Proxy hostname for auto-configured URLs", "vault")
    .action(async (name: string, value: string | undefined, opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        validateSecretName(name);
        // Resolve value early — before any other stdin usage (e.g. AGE_SECRET_KEY prompt)
        const secretValue = await resolveSecretValue(value, Boolean(opts.stdin));

        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);
        const publicKey = cfg.vault?.publicKey;

        if (!publicKey) {
          throw new Error("No vault public key in config. Run 'openclaw vault init' first.");
        }

        // Decrypt existing secrets (or start fresh if vault.age doesn't exist yet)
        let secrets: Map<string, string>;
        if (fs.existsSync(vaultPath)) {
          const secretKey = await resolveAgeSecretKey();
          secrets = await decryptVault(vaultPath, secretKey);
        } else {
          secrets = new Map();
        }

        const isUpdate = secrets.has(name);
        secrets.set(name, secretValue);
        await encryptVault(secrets, publicKey, vaultPath);

        defaultRuntime.log(`${isUpdate ? "Updated" : "Added"} secret: ${name}`);

        // Auto-configure proxy for known providers
        if (opts.proxy !== false) {
          const matchingProvider = findProviderBySecretName(name);
          if (matchingProvider) {
            const [providerName] = matchingProvider;
            const proxyUrl = providerProxyUrl(providerName, opts.proxyHost);
            if (proxyUrl) {
              const snapshot = await readConfigFileSnapshot();
              const existingProxies = snapshot.config.vault?.proxies ?? {};
              if (!existingProxies[providerName]) {
                const next = {
                  ...snapshot.config,
                  vault: {
                    ...snapshot.config.vault,
                    proxies: {
                      ...existingProxies,
                      [providerName]: proxyUrl,
                    },
                  },
                };
                await writeConfigFile(next);
                defaultRuntime.log(`Auto-configured proxy: ${providerName} -> ${proxyUrl}`);
              }
            }
          }
        }
      }),
    );

  // ---- remove --------------------------------------------------------------
  vault
    .command("remove <name>")
    .description("Remove a secret from vault.age")
    .action(async (name: string) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        validateSecretName(name);
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);
        const publicKey = cfg.vault?.publicKey;

        if (!publicKey) {
          throw new Error("No vault public key in config. Run 'openclaw vault init' first.");
        }
        if (!fs.existsSync(vaultPath)) {
          throw new Error(`Vault file not found: ${vaultPath}`);
        }

        const secretKey = await resolveAgeSecretKey();
        const secrets = await decryptVault(vaultPath, secretKey);

        if (!secrets.has(name)) {
          throw new Error(`Secret not found in vault: ${name}`);
        }

        secrets.delete(name);
        await encryptVault(secrets, publicKey, vaultPath);
        defaultRuntime.log(`Removed secret: ${name}`);

        // Remove matching proxy entry from config
        const matchingProvider = findProviderBySecretName(name);
        if (matchingProvider) {
          const [providerName] = matchingProvider;
          const snapshot = await readConfigFileSnapshot();
          const existingProxies = snapshot.config.vault?.proxies;
          if (existingProxies?.[providerName]) {
            const { [providerName]: _, ...remainingProxies } = existingProxies;
            const next = {
              ...snapshot.config,
              vault: {
                ...snapshot.config.vault,
                proxies: remainingProxies,
              },
            };
            await writeConfigFile(next);
            defaultRuntime.log(`Removed proxy mapping: ${providerName}`);
          }
        }
      }),
    );

  // ---- list ----------------------------------------------------------------
  vault
    .command("list")
    .description("List secrets stored in vault.age")
    .option("--reveal", "Show partial secret values (first 4 + last 4 chars)")
    .option("--json", "Output as JSON")
    .action(async (opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);

        if (!fs.existsSync(vaultPath)) {
          throw new Error(`Vault file not found: ${vaultPath}`);
        }

        const secretKey = await resolveAgeSecretKey();
        const secrets = await decryptVault(vaultPath, secretKey);

        if (opts.json) {
          const obj: Record<string, string> = {};
          for (const [key, value] of secrets) {
            obj[key] = opts.reveal ? value : maskValue(value);
          }
          defaultRuntime.log(JSON.stringify(obj, null, 2));
          return;
        }

        if (secrets.size === 0) {
          defaultRuntime.log(theme.muted("Vault is empty."));
          return;
        }

        const rows = [...secrets.entries()].map(([key, value]) => ({
          Name: key,
          Value: opts.reveal ? maskValue(value) : "(hidden)",
        }));

        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        defaultRuntime.log(theme.heading(`Vault secrets (${secrets.size})`));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Secret", minWidth: 24 },
              { key: "Value", header: "Value", minWidth: 24, flex: true },
            ],
            rows,
          }).trimEnd(),
        );
      }),
    );

  // ---- migrate -------------------------------------------------------------
  vault
    .command("migrate")
    .description("Migrate plaintext API keys from config into vault.age")
    .option("--dry-run", "Preview changes without modifying files", false)
    .option("--proxy-host <host>", "Proxy hostname for auto-configured URLs", "vault")
    .action(async (opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const snapshot = await readConfigFileSnapshot();
        const cfg = snapshot.config;
        const providers = cfg.models?.providers;
        if (!providers || Object.keys(providers).length === 0) {
          defaultRuntime.log(theme.muted("No providers configured."));
          return;
        }

        // Collect providers with plaintext apiKey
        const toMigrate: Array<{
          providerName: string;
          apiKey: string;
          secretName: string;
        }> = [];
        for (const [providerName, providerCfg] of Object.entries(providers)) {
          const apiKey = (providerCfg as { apiKey?: string }).apiKey;
          if (!apiKey || apiKey === VAULT_PROXY_PLACEHOLDER_KEY) {
            continue;
          }
          const secretName =
            providerSecretName(providerName) ??
            `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
          toMigrate.push({ providerName, apiKey, secretName });
        }

        // Build default proxy mappings for ALL known providers
        const defaultProxies = buildDefaultProxyMap(opts.proxyHost);

        if (toMigrate.length === 0) {
          if (opts.dryRun) {
            defaultRuntime.log(
              theme.muted("No plaintext API keys found. Default proxy mappings would be written."),
            );
            return;
          }

          // No keys to migrate, but still ensure default proxy mappings exist
          const next = {
            ...snapshot.config,
            vault: {
              ...snapshot.config.vault,
              proxies: {
                ...defaultProxies,
                ...snapshot.config.vault?.proxies, // preserve user overrides
              },
            },
          };
          await writeConfigFile(next);
          defaultRuntime.log(theme.muted("No plaintext API keys found in provider config."));
          defaultRuntime.log("Default proxy mappings updated.");
          return;
        }

        // Show summary
        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        defaultRuntime.log(theme.heading("Migration plan"));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Provider", header: "Provider", minWidth: 14 },
              { key: "Secret", header: "Secret Name", minWidth: 24 },
              { key: "Proxy", header: "Proxy URL", minWidth: 24, flex: true },
            ],
            rows: toMigrate.map(({ providerName, secretName }) => ({
              Provider: providerName,
              Secret: secretName,
              Proxy: providerProxyUrl(providerName, opts.proxyHost) ?? "(manual setup needed)",
            })),
          }).trimEnd(),
        );

        if (opts.dryRun) {
          defaultRuntime.log("");
          defaultRuntime.log(theme.muted("Dry run — no changes made."));
          return;
        }

        // Initialize vault if needed
        const vaultPath = resolveVaultFilePath(cfg);
        let publicKey = cfg.vault?.publicKey;
        let printedIdentity: string | undefined;

        if (!publicKey) {
          const keypair = await generateKeypair();
          publicKey = keypair.recipient;
          printedIdentity = keypair.identity;

          // Create empty vault
          await encryptVault(new Map(), publicKey, vaultPath);
        }

        // Decrypt existing vault (or start fresh)
        let secrets: Map<string, string>;
        if (fs.existsSync(vaultPath)) {
          if (!printedIdentity) {
            // Existing vault — need key to decrypt
            const secretKey = await resolveAgeSecretKey();
            secrets = await decryptVault(vaultPath, secretKey);
          } else {
            // We just created it — empty
            secrets = new Map();
          }
        } else {
          secrets = new Map();
        }

        // Add secrets and build proxy mappings (migrated providers override defaults)
        const proxyMappings: Record<string, string> = { ...defaultProxies };
        for (const { providerName, apiKey, secretName } of toMigrate) {
          secrets.set(secretName, apiKey);
          const proxyUrl = providerProxyUrl(providerName, opts.proxyHost);
          if (proxyUrl) {
            proxyMappings[providerName] = proxyUrl;
          }
        }

        await encryptVault(secrets, publicKey, vaultPath);

        // Update config: set vault enabled, proxies, publicKey; remove plaintext keys
        const nextProviders = { ...providers };
        for (const { providerName } of toMigrate) {
          const provider = nextProviders[providerName];
          if (provider && typeof provider === "object") {
            const { apiKey: _, ...rest } = provider as Record<string, unknown>;
            nextProviders[providerName] = rest as typeof provider;
          }
        }

        const next = {
          ...snapshot.config,
          vault: {
            ...snapshot.config.vault,
            enabled: true,
            publicKey,
            proxies: {
              ...snapshot.config.vault?.proxies,
              ...proxyMappings,
            },
          },
          models: {
            ...snapshot.config.models,
            providers: nextProviders,
          },
        };
        await writeConfigFile(next);

        defaultRuntime.log("");
        defaultRuntime.log(theme.success(`Migrated ${toMigrate.length} secret(s) to vault.`));
        defaultRuntime.log(`Vault file: ${vaultPath}`);

        if (printedIdentity) {
          defaultRuntime.log("");
          defaultRuntime.log(
            theme.warn("Save this secret key securely. It will not be shown again:"),
          );
          defaultRuntime.log("");
          defaultRuntime.log(`  ${printedIdentity}`);
          defaultRuntime.log("");
          defaultRuntime.log(
            theme.muted("Store it in a password manager (KeePass, 1Password, etc.)."),
          );
        }
      }),
    );
}
