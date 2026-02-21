/**
 * Tests for `openclaw vault` CLI subcommands.
 *
 * Uses real temp directories with actual age encryption/decryption (no mocks
 * for crypto). Config IO is mocked to use isolated temp paths.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  decryptVault,
  encryptVault,
  generateKeypair,
  type AgeKeypair,
} from "../vault/operations.js";

// ---------------------------------------------------------------------------
// Mock stdin for --stdin tests (must be set BEFORE createVaultProgram)
// ---------------------------------------------------------------------------

const stdinOverride = vi.hoisted(() => ({ current: null as Readable | null }));

vi.mock("node:process", async () => {
  const actual = await vi.importActual<typeof import("node:process")>("node:process");
  return {
    ...actual,
    get stdin() {
      return stdinOverride.current ?? actual.stdin;
    },
  };
});

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let configPath: string;
let vaultPath: string;

function writeConfig(cfg: OpenClawConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Mocking: redirect config paths to temp directory
// ---------------------------------------------------------------------------

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(),
    readConfigFileSnapshot: vi.fn(),
    writeConfigFile: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../vault/operations.js", async () => {
  const actual =
    await vi.importActual<typeof import("../vault/operations.js")>("../vault/operations.js");
  return {
    ...actual,
    resolveVaultFilePath: vi.fn(),
    resolveAgeSecretKey: vi.fn(),
  };
});

async function setupMocks(cfg: OpenClawConfig, keypair?: AgeKeypair) {
  const { loadConfig, readConfigFileSnapshot, writeConfigFile } =
    await import("../config/config.js");
  const { resolveVaultFilePath, resolveAgeSecretKey } = await import("../vault/operations.js");

  vi.mocked(loadConfig).mockReturnValue(cfg);
  vi.mocked(readConfigFileSnapshot).mockResolvedValue({
    path: configPath,
    exists: true,
    raw: JSON.stringify(cfg),
    parsed: cfg,
    resolved: cfg,
    valid: true,
    config: cfg,
    hash: "test",
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  vi.mocked(writeConfigFile).mockImplementation(async (next) => {
    writeConfig(next);
  });
  vi.mocked(resolveVaultFilePath).mockReturnValue(vaultPath);

  if (keypair) {
    vi.mocked(resolveAgeSecretKey).mockResolvedValue(keypair.identity);
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vault-cli-test-"));
  configPath = path.join(tmpDir, "openclaw.json");
  vaultPath = path.join(tmpDir, "vault.age");
});

afterEach(async () => {
  stdinOverride.current = null;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function createVaultProgram() {
  const { registerVaultCli } = await import("./vault-cli.js");
  const { Command } = await import("commander");
  const program = new Command();
  registerVaultCli(program);
  return program;
}

type ProviderEntry = OpenClawConfig["models"] extends { providers?: infer P }
  ? P extends Record<string, infer V>
    ? V
    : never
  : never;

describe("vault init", () => {
  it("creates vault.age and updates config with default proxy mappings", async () => {
    const cfg: OpenClawConfig = {};
    await setupMocks(cfg);
    writeConfig(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "init"]);

    // vault.age should exist
    expect(fs.existsSync(vaultPath)).toBe(true);

    // writeConfigFile should have been called with vault enabled + publicKey + default proxies
    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).toHaveBeenCalled();
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];
    expect(writtenConfig?.vault?.enabled).toBe(true);
    expect(writtenConfig?.vault?.publicKey).toMatch(/^age1/);

    // Default proxy mappings for all known providers
    const proxies = writtenConfig?.vault?.proxies;
    expect(proxies?.openai).toBe("http://vault:8081");
    expect(proxies?.anthropic).toBe("http://vault:8082");
    expect(proxies?.deepgram).toBe("http://vault:8083");
    expect(proxies?.["openai-compat"]).toBe("http://vault:8084");
    expect(proxies?.google).toBe("http://vault:8085");
    expect(proxies?.groq).toBe("http://vault:8086");
    expect(proxies?.xai).toBe("http://vault:8087");
    expect(proxies?.mistral).toBe("http://vault:8088");
    expect(proxies?.brave).toBe("http://vault:8089");
    expect(proxies?.perplexity).toBe("http://vault:8090");
  });

  it("preserves user proxy overrides during init", async () => {
    const cfg: OpenClawConfig = {
      vault: {
        proxies: { openai: "http://custom:9999" },
      },
    };
    await setupMocks(cfg);
    writeConfig(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "init"]);

    const { writeConfigFile } = await import("../config/config.js");
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];

    // User override preserved (takes precedence over default)
    expect(writtenConfig?.vault?.proxies?.openai).toBe("http://custom:9999");
    // Other defaults still written
    expect(writtenConfig?.vault?.proxies?.groq).toBe("http://vault:8086");
  });

  it("errors if vault.age exists without --force", async () => {
    const cfg: OpenClawConfig = {};
    await setupMocks(cfg);
    // Create an existing vault file
    fs.writeFileSync(vaultPath, "existing", "utf-8");

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "init"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/already exists/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("overwrites with --force", async () => {
    const cfg: OpenClawConfig = {};
    await setupMocks(cfg);
    writeConfig(cfg);
    fs.writeFileSync(vaultPath, "existing", "utf-8");

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "init", "--force"]);

    // Should succeed — vault.age recreated
    expect(fs.existsSync(vaultPath)).toBe(true);
    // Should be valid age ciphertext now, not "existing"
    const content = fs.readFileSync(vaultPath);
    expect(content.toString()).not.toBe("existing");
  });
});

describe("vault add + list round-trip", () => {
  it("adds a secret and lists it", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    // Create empty vault first
    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    // Add a secret
    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "OPENAI_API_KEY",
      "sk-test123",
      "--no-proxy",
    ]);

    // Verify it's in the vault
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("OPENAI_API_KEY")).toBe("sk-test123");
  });

  it("auto-configures proxy for known providers", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "add", "OPENAI_API_KEY", "sk-test123"]);

    // writeConfigFile should have been called with proxy mapping
    const { writeConfigFile } = await import("../config/config.js");
    const calls = vi.mocked(writeConfigFile).mock.calls;
    const proxyCall = calls.find((c) => c[0]?.vault?.proxies?.openai);
    expect(proxyCall).toBeTruthy();
    expect(proxyCall?.[0]?.vault?.proxies?.openai).toBe("http://vault:8081");
  });

  it("skips proxy config with --no-proxy", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "OPENAI_API_KEY",
      "sk-test123",
      "--no-proxy",
    ]);

    // writeConfigFile should NOT have been called with proxy mapping
    const { writeConfigFile } = await import("../config/config.js");
    const calls = vi.mocked(writeConfigFile).mock.calls;
    const proxyCall = calls.find((c) => c[0]?.vault?.proxies?.openai);
    expect(proxyCall).toBeUndefined();
  });
});

describe("vault add updates existing secret", () => {
  it("overwrites value and logs 'Updated' for pre-existing secret", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    // Seed vault with an existing secret
    await encryptVault(new Map([["OPENAI_API_KEY", "sk-old-value"]]), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    // Overwrite the same secret with a new value
    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "OPENAI_API_KEY",
      "sk-new-value",
      "--no-proxy",
    ]);

    // Vault should contain the new value
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("OPENAI_API_KEY")).toBe("sk-new-value");
    expect(secrets.size).toBe(1);

    // Output should say "Updated", not "Added"
    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    expect(logCalls.some((msg) => typeof msg === "string" && msg.includes("Updated"))).toBe(true);
  });
});

describe("vault add resolveSecretValue paths", () => {
  it("reads secret value from stdin with --stdin flag", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);
    await encryptVault(new Map(), keypair.recipient, vaultPath);

    // Set up mock stdin BEFORE importing vault-cli (stdinStream is captured at import time)
    stdinOverride.current = Readable.from([Buffer.from("  sk-from-stdin  \n")]);

    const program = await createVaultProgram();

    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "OPENAI_API_KEY",
      "--stdin",
      "--no-proxy",
    ]);

    stdinOverride.current = null;

    // Value should be trimmed
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("OPENAI_API_KEY")).toBe("sk-from-stdin");
  });

  it("errors when --stdin provides empty input", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);
    await encryptVault(new Map(), keypair.recipient, vaultPath);

    stdinOverride.current = Readable.from([Buffer.from("   \n")]);

    const program = await createVaultProgram();

    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "OPENAI_API_KEY",
      "--stdin",
      "--no-proxy",
    ]);

    stdinOverride.current = null;

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(
      /Empty value received from stdin/,
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when no value, no --stdin, and stdin is not a TTY", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);
    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    // No value argument, no --stdin flag, and stdin.isTTY is falsy in test env
    await program.parseAsync(["node", "test", "vault", "add", "OPENAI_API_KEY", "--no-proxy"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/No secret value provided/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

describe("vault add error paths", () => {
  it("errors when no public key in config", async () => {
    const cfg: OpenClawConfig = { vault: { enabled: true } };
    await setupMocks(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "add", "KEY", "value", "--no-proxy"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/public key/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("creates new vault when vault.age does not exist", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);
    // Do NOT create vault.age — add should start fresh

    const program = await createVaultProgram();

    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "TEST_KEY",
      "test-value",
      "--no-proxy",
    ]);

    // Should have created vault.age with the new secret
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("TEST_KEY")).toBe("test-value");
    expect(secrets.size).toBe(1);
  });
});

describe("vault remove", () => {
  it("removes an existing secret and proxy", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        publicKey: keypair.recipient,
        proxies: { openai: "http://vault:8081" },
      },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    // Create vault with a secret
    await encryptVault(new Map([["OPENAI_API_KEY", "sk-test"]]), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "remove", "OPENAI_API_KEY"]);

    // Secret should be gone
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.has("OPENAI_API_KEY")).toBe(false);

    // Proxy mapping should also be removed from config
    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).toHaveBeenCalled();
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];
    expect(writtenConfig?.vault?.proxies?.openai).toBeUndefined();
  });

  it("errors for missing secret", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);

    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "remove", "NONEXISTENT"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/not found in vault/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

describe("vault list", () => {
  it("lists secret names with hidden values by default", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);

    await encryptVault(
      new Map([
        ["OPENAI_API_KEY", "sk-test-key-0123456789"],
        ["ANTHROPIC_API_KEY", "ant-test-key-abc"],
      ]),
      keypair.recipient,
      vaultPath,
    );

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");

    // Should contain secret names
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).toContain("ANTHROPIC_API_KEY");
    // Should NOT contain actual values
    expect(output).not.toContain("sk-test-key-0123456789");
    expect(output).not.toContain("ant-test-key-abc");
    // Should show hidden placeholder
    expect(output).toContain("(hidden)");
  });

  it("shows masked values with --reveal", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);

    await encryptVault(
      new Map([["OPENAI_API_KEY", "sk-test-key-0123456789"]]),
      keypair.recipient,
      vaultPath,
    );

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list", "--reveal"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");

    // Should show first 4 and last 4 chars with asterisks in between
    expect(output).toContain("sk-t");
    expect(output).toContain("6789");
    // Should NOT contain the full value
    expect(output).not.toContain("sk-test-key-0123456789");
    // Should not show "(hidden)" since --reveal is active
    expect(output).not.toContain("(hidden)");
  });

  it("outputs JSON with --json", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);

    await encryptVault(
      new Map([["OPENAI_API_KEY", "sk-test-key-0123456789"]]),
      keypair.recipient,
      vaultPath,
    );

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list", "--json"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    // JSON mode outputs a single JSON string
    const jsonOutput = JSON.parse(logCalls[0] as string);
    expect(jsonOutput).toHaveProperty("OPENAI_API_KEY");
    // Without --reveal, JSON values are masked
    expect(jsonOutput.OPENAI_API_KEY).toContain("*");
    expect(jsonOutput.OPENAI_API_KEY).not.toBe("sk-test-key-0123456789");
  });

  it("outputs raw values with --json --reveal", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);

    await encryptVault(new Map([["KEY", "abcdefghijklmnop"]]), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list", "--json", "--reveal"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const jsonOutput = JSON.parse(logCalls[0] as string);
    // --reveal in JSON mode shows the raw value (for scripting/export)
    expect(jsonOutput.KEY).toBe("abcdefghijklmnop");
  });

  it("shows empty message for empty vault", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);

    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");
    expect(output).toContain("empty");
  });

  it("masks values in JSON without --reveal (short fully, long partially)", async () => {
    const keypair = await generateKeypair();
    const cfg: OpenClawConfig = { vault: { enabled: true, publicKey: keypair.recipient } };
    await setupMocks(cfg, keypair);
    await encryptVault(
      new Map([
        ["SHORT", "abcd1234"],
        ["LONG", "sk-test-key-0123456789"],
      ]),
      keypair.recipient,
      vaultPath,
    );

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list", "--json"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const jsonOutput = JSON.parse(logCalls[0] as string);
    // 8-char value should be fully masked
    expect(jsonOutput.SHORT).toBe("********");
    // Long value: first 4 + last 4 visible, middle masked
    const masked = jsonOutput.LONG as string;
    expect(masked.slice(0, 4)).toBe("sk-t");
    expect(masked.slice(-4)).toBe("6789");
    expect(masked).toContain("*");
    expect(masked.length).toBe("sk-test-key-0123456789".length);
  });

  it("partially reveals 9-char values at the masking boundary", async () => {
    const keypair = await generateKeypair();
    const cfg: OpenClawConfig = { vault: { enabled: true, publicKey: keypair.recipient } };
    await setupMocks(cfg, keypair);
    await encryptVault(new Map([["KEY", "123456789"]]), keypair.recipient, vaultPath);
    const program = await createVaultProgram();
    await program.parseAsync(["node", "test", "vault", "list", "--json"]);
    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const jsonOutput = JSON.parse(logCalls[0] as string);
    // 9 chars: first 4 visible, 1 asterisk, last 4 visible
    expect(jsonOutput.KEY).toBe("1234*6789");
  });

  it("errors when vault file does not exist", async () => {
    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: "age1test" },
    };
    await setupMocks(cfg);
    // Do NOT create vault.age

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "list"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/not found/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

describe("vault migrate", () => {
  it("migrates plaintext keys and removes them from config", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            name: "openai",
            apiKey: "sk-real-key",
          } as ProviderEntry,
          anthropic: {
            name: "anthropic",
            apiKey: "ant-real-key",
          } as ProviderEntry,
        },
      },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    // Mock resolveAgeSecretKey won't be needed for fresh init path
    // but generateKeypair is real — we need to mock it to get our known keypair
    const vaultOps = await import("../vault/operations.js");
    // We patch generateKeypair to return our known keypair so we can verify decryption
    vi.spyOn(vaultOps, "generateKeypair").mockResolvedValue(keypair);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate"]);

    // vault.age should exist with migrated secrets
    expect(fs.existsSync(vaultPath)).toBe(true);
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("OPENAI_API_KEY")).toBe("sk-real-key");
    expect(secrets.get("ANTHROPIC_API_KEY")).toBe("ant-real-key");

    // writeConfigFile should have been called without plaintext apiKeys
    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).toHaveBeenCalled();
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];
    const providers = writtenConfig?.models?.providers as
      | Record<string, { apiKey?: string }>
      | undefined;
    expect(providers?.openai?.apiKey).toBeUndefined();
    expect(providers?.anthropic?.apiKey).toBeUndefined();

    // Should have vault config with all default proxy mappings
    expect(writtenConfig?.vault?.enabled).toBe(true);
    expect(writtenConfig?.vault?.publicKey).toMatch(/^age1/);
    expect(writtenConfig?.vault?.proxies?.openai).toBe("http://vault:8081");
    expect(writtenConfig?.vault?.proxies?.anthropic).toBe("http://vault:8082");
    // Default proxy mappings for non-migrated providers should also be present
    expect(writtenConfig?.vault?.proxies?.groq).toBe("http://vault:8086");
    expect(writtenConfig?.vault?.proxies?.brave).toBe("http://vault:8089");
    expect(writtenConfig?.vault?.proxies?.perplexity).toBe("http://vault:8090");
  });

  it("dry-run does not modify files", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            name: "openai",
            apiKey: "sk-real-key",
          } as ProviderEntry,
        },
      },
    };
    await setupMocks(cfg);
    writeConfig(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate", "--dry-run"]);

    // vault.age should NOT have been created
    expect(fs.existsSync(vaultPath)).toBe(false);

    // Config should not have been written
    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("skips providers with vault-proxy-managed sentinel", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            name: "openai",
            apiKey: "vault-proxy-managed",
          } as ProviderEntry,
          anthropic: {
            name: "anthropic",
            apiKey: "ant-real-key",
          } as ProviderEntry,
        },
      },
    };
    const keypair = await generateKeypair();
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    const vaultOps = await import("../vault/operations.js");
    vi.spyOn(vaultOps, "generateKeypair").mockResolvedValue(keypair);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate"]);

    // Only anthropic should be migrated; openai has sentinel value
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(secrets.get("ANTHROPIC_API_KEY")).toBe("ant-real-key");
    expect(secrets.has("OPENAI_API_KEY")).toBe(false);

    // Config should retain openai apiKey unchanged (sentinel stays)
    const { writeConfigFile } = await import("../config/config.js");
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];
    const providers = writtenConfig?.models?.providers as
      | Record<string, { apiKey?: string }>
      | undefined;
    expect(providers?.openai?.apiKey).toBe("vault-proxy-managed");
    expect(providers?.anthropic?.apiKey).toBeUndefined();
  });

  it("merges into existing vault when vault.age already exists", async () => {
    const keypair = await generateKeypair();

    // Pre-populate vault with an existing secret
    await encryptVault(
      new Map([["EXISTING_SECRET", "existing-value"]]),
      keypair.recipient,
      vaultPath,
    );

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
      models: {
        providers: {
          openai: {
            name: "openai",
            apiKey: "sk-new-key",
          } as ProviderEntry,
        },
      },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate"]);

    // Both existing and migrated secrets should be present
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("EXISTING_SECRET")).toBe("existing-value");
    expect(secrets.get("OPENAI_API_KEY")).toBe("sk-new-key");
    expect(secrets.size).toBe(2);
  });
});

describe("vault status output", () => {
  it("shows enabled state, file info, public key, and proxy mappings", async () => {
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        publicKey: "age1testpubkey",
        proxies: { openai: "http://vault:8081", anthropic: "http://vault:8082" },
      },
    };
    await setupMocks(cfg);

    // Create a vault file so "exists" check works
    fs.writeFileSync(vaultPath, "test-data", "utf-8");

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "status"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");

    expect(output).toContain("yes"); // enabled
    expect(output).toContain(vaultPath);
    expect(output).toContain("age1testpubkey");
    expect(output).toContain("openai");
    expect(output).toContain("http://vault:8081");
    expect(output).toContain("anthropic");
    expect(output).toContain("http://vault:8082");
  });

  it("shows disabled state and missing file", async () => {
    const cfg: OpenClawConfig = {};
    await setupMocks(cfg);
    // Do NOT create vault file

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "status"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");

    expect(output).toContain("no"); // enabled = no
    expect(output).toContain("(not set)"); // no public key
    expect(output).toContain("(none)"); // no proxy mappings
  });
});

describe("vault remove error paths", () => {
  it("errors when no public key in config", async () => {
    const cfg: OpenClawConfig = { vault: { enabled: true } };
    await setupMocks(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "remove", "OPENAI_API_KEY"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/public key/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when vault file does not exist", async () => {
    const keypair = await generateKeypair();
    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    // Do NOT create vault.age

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "remove", "OPENAI_API_KEY"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/not found/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects invalid secret names", async () => {
    const cfg: OpenClawConfig = { vault: { enabled: true } };
    await setupMocks(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "remove", "invalid-name"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/Invalid secret name/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

describe("vault add secret name validation", () => {
  it("rejects lowercase names", async () => {
    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: "age1test" },
    };
    await setupMocks(cfg);

    const program = await createVaultProgram();

    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "lowercase_name",
      "value",
      "--no-proxy",
    ]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/Invalid secret name/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects names starting with digits", async () => {
    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: "age1test" },
    };
    await setupMocks(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "add", "1NVALID", "value", "--no-proxy"]);

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.error).mock.calls[0]?.[0]).toMatch(/Invalid secret name/);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

describe("vault migrate edge cases", () => {
  it("reports no providers when models.providers is empty", async () => {
    const cfg: OpenClawConfig = { models: { providers: {} } };
    await setupMocks(cfg);
    writeConfig(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");
    expect(output).toContain("No providers configured");

    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("writes default proxy mappings when all keys have sentinel value", async () => {
    const cfg: OpenClawConfig = {
      vault: { enabled: true },
      models: {
        providers: {
          openai: {
            name: "openai",
            apiKey: "vault-proxy-managed",
          } as ProviderEntry,
        },
      },
    };
    await setupMocks(cfg);
    writeConfig(cfg);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate"]);

    const { defaultRuntime } = await import("../runtime.js");
    const logCalls = vi.mocked(defaultRuntime.log).mock.calls.map((c) => c[0]);
    const output = logCalls.join("\n");
    expect(output).toContain("No plaintext API keys");
    expect(output).toContain("Default proxy mappings updated");

    // Should still write config with default proxy mappings
    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).toHaveBeenCalled();
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];
    expect(writtenConfig?.vault?.proxies?.openai).toBe("http://vault:8081");
    expect(writtenConfig?.vault?.proxies?.groq).toBe("http://vault:8086");
    expect(writtenConfig?.vault?.proxies?.brave).toBe("http://vault:8089");
  });

  it("skips local providers without vault proxy mapping", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            name: "openai",
            apiKey: "sk-real-key",
          } as ProviderEntry,
          ollama: {
            name: "ollama",
            apiKey: "ollama-local",
          } as ProviderEntry,
          autorouter: {
            name: "autorouter",
            apiKey: "sk-autorouter-local",
          } as ProviderEntry,
        },
      },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    const vaultOps = await import("../vault/operations.js");
    vi.spyOn(vaultOps, "generateKeypair").mockResolvedValue(keypair);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "migrate"]);

    // openai should be migrated (known vault proxy mapping)
    const secrets = await decryptVault(vaultPath, keypair.identity);
    expect(secrets.get("OPENAI_API_KEY")).toBe("sk-real-key");

    // ollama and autorouter should NOT be in the vault
    expect(secrets.has("OLLAMA_API_KEY")).toBe(false);
    expect(secrets.has("AUTOROUTER_API_KEY")).toBe(false);

    // Config should retain ollama/autorouter apiKeys unchanged
    const { writeConfigFile } = await import("../config/config.js");
    const writtenConfig = vi.mocked(writeConfigFile).mock.calls[0]?.[0];
    const providers = writtenConfig?.models?.providers as
      | Record<string, { apiKey?: string }>
      | undefined;
    expect(providers?.openai?.apiKey).toBeUndefined();
    expect(providers?.ollama?.apiKey).toBe("ollama-local");
    expect(providers?.autorouter?.apiKey).toBe("sk-autorouter-local");
  });
});

describe("vault add proxy edge cases", () => {
  it("skips proxy config when provider already has a proxy entry", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        publicKey: keypair.recipient,
        proxies: { openai: "http://custom-vault:9999" },
      },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync(["node", "test", "vault", "add", "OPENAI_API_KEY", "sk-test123"]);

    // writeConfigFile should NOT have been called — existing proxy preserved
    const { writeConfigFile } = await import("../config/config.js");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("uses custom proxy host with --proxy-host", async () => {
    const keypair = await generateKeypair();

    const cfg: OpenClawConfig = {
      vault: { enabled: true, publicKey: keypair.recipient },
    };
    await setupMocks(cfg, keypair);
    writeConfig(cfg);

    await encryptVault(new Map(), keypair.recipient, vaultPath);

    const program = await createVaultProgram();

    await program.parseAsync([
      "node",
      "test",
      "vault",
      "add",
      "OPENAI_API_KEY",
      "sk-test123",
      "--proxy-host",
      "my-vault",
    ]);

    const { writeConfigFile } = await import("../config/config.js");
    const calls = vi.mocked(writeConfigFile).mock.calls;
    const proxyCall = calls.find((c) => c[0]?.vault?.proxies?.openai);
    expect(proxyCall).toBeDefined();
    expect(proxyCall?.[0]?.vault?.proxies?.openai).toBe("http://my-vault:8081");
  });
});
