import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VAULT_PROVIDER_DEFAULTS,
  buildDefaultProxyMap,
  decryptVault,
  encryptVault,
  findProviderBySecretName,
  generateKeypair,
  parseVaultSecrets,
  providerProxyUrl,
  providerSecretName,
  resolveAgeSecretKey,
  resolveVaultFilePath,
  serializeVaultSecrets,
} from "./operations.js";

// ---------------------------------------------------------------------------
// parseVaultSecrets / serializeVaultSecrets
// ---------------------------------------------------------------------------

describe("parseVaultSecrets", () => {
  it("parses KEY=VALUE lines", () => {
    const input = "OPENAI_API_KEY=sk-123\nANTHROPIC_API_KEY=ant-456\n";
    const result = parseVaultSecrets(input);
    expect(result.get("OPENAI_API_KEY")).toBe("sk-123");
    expect(result.get("ANTHROPIC_API_KEY")).toBe("ant-456");
    expect(result.size).toBe(2);
  });

  it("skips blank lines and comments", () => {
    const input = "# This is a comment\n\nKEY=value\n  # another comment\n  \n";
    const result = parseVaultSecrets(input);
    expect(result.size).toBe(1);
    expect(result.get("KEY")).toBe("value");
  });

  it("strips surrounding double quotes from values", () => {
    const result = parseVaultSecrets('KEY="quoted value"');
    expect(result.get("KEY")).toBe("quoted value");
  });

  it("strips surrounding single quotes from values", () => {
    const result = parseVaultSecrets("KEY='quoted value'");
    expect(result.get("KEY")).toBe("quoted value");
  });

  it("preserves values with equals signs", () => {
    const result = parseVaultSecrets("KEY=value=with=equals");
    expect(result.get("KEY")).toBe("value=with=equals");
  });

  it("returns empty map for empty input", () => {
    expect(parseVaultSecrets("").size).toBe(0);
    expect(parseVaultSecrets("\n\n").size).toBe(0);
  });

  it("skips lines without equals sign", () => {
    const result = parseVaultSecrets("NO_EQUALS\nKEY=value");
    expect(result.size).toBe(1);
    expect(result.get("KEY")).toBe("value");
  });
});

describe("serializeVaultSecrets", () => {
  it("serializes to KEY=VALUE format with trailing newline", () => {
    const secrets = new Map([
      ["A", "1"],
      ["B", "2"],
    ]);
    const result = serializeVaultSecrets(secrets);
    expect(result).toBe("A=1\nB=2\n");
  });

  it("returns empty string for empty map", () => {
    expect(serializeVaultSecrets(new Map())).toBe("");
  });
});

describe("parseVaultSecrets + serializeVaultSecrets round-trip", () => {
  it("preserves all entries through round-trip", () => {
    const original = new Map([
      ["OPENAI_API_KEY", "sk-abc123"],
      ["ANTHROPIC_API_KEY", "ant-xyz789"],
      ["DEEPGRAM_API_KEY", "dg-key"],
    ]);
    const serialized = serializeVaultSecrets(original);
    const parsed = parseVaultSecrets(serialized);
    expect(parsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// generateKeypair
// ---------------------------------------------------------------------------

describe("generateKeypair", () => {
  it("returns valid identity and recipient", async () => {
    const keypair = await generateKeypair();
    expect(keypair.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(keypair.recipient).toMatch(/^age1/);
  });

  it("generates unique keypairs each time", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    expect(kp1.identity).not.toBe(kp2.identity);
    expect(kp1.recipient).not.toBe(kp2.recipient);
  });
});

// ---------------------------------------------------------------------------
// encryptVault + decryptVault round-trip
// ---------------------------------------------------------------------------

describe("encryptVault + decryptVault round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vault-ops-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("encrypts and decrypts secrets round-trip", async () => {
    const keypair = await generateKeypair();
    const vaultPath = path.join(tmpDir, "vault.age");
    const secrets = new Map([
      ["OPENAI_API_KEY", "sk-test-key"],
      ["ANTHROPIC_API_KEY", "ant-test-key"],
    ]);

    await encryptVault(secrets, keypair.recipient, vaultPath);

    // File should exist with restricted permissions
    const stat = await fs.promises.stat(vaultPath);
    expect(stat.isFile()).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);

    // Ciphertext should not contain plaintext
    const ciphertext = await fs.promises.readFile(vaultPath, "utf-8");
    expect(ciphertext).not.toContain("sk-test-key");

    // Decrypt and verify
    const decrypted = await decryptVault(vaultPath, keypair.identity);
    expect(decrypted.get("OPENAI_API_KEY")).toBe("sk-test-key");
    expect(decrypted.get("ANTHROPIC_API_KEY")).toBe("ant-test-key");
    expect(decrypted.size).toBe(2);
  });

  it("encrypts empty secrets", async () => {
    const keypair = await generateKeypair();
    const vaultPath = path.join(tmpDir, "vault.age");
    const secrets = new Map<string, string>();

    await encryptVault(secrets, keypair.recipient, vaultPath);
    const decrypted = await decryptVault(vaultPath, keypair.identity);
    expect(decrypted.size).toBe(0);
  });

  it("throws on wrong decryption key with user-friendly message", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const vaultPath = path.join(tmpDir, "vault.age");

    await encryptVault(new Map([["K", "V"]]), kp1.recipient, vaultPath);
    await expect(decryptVault(vaultPath, kp2.identity)).rejects.toThrow(
      /Failed to decrypt vault[\s\S]*corrupted[\s\S]*wrong/,
    );
  });

  it("throws on corrupted vault file with user-friendly message", async () => {
    const keypair = await generateKeypair();
    const vaultPath = path.join(tmpDir, "vault.age");

    await fs.promises.writeFile(vaultPath, "not-valid-age-ciphertext");
    await expect(decryptVault(vaultPath, keypair.identity)).rejects.toThrow(
      /Failed to decrypt vault/,
    );
  });

  it("throws when vault file does not exist", async () => {
    const keypair = await generateKeypair();
    await expect(
      decryptVault(path.join(tmpDir, "nonexistent.age"), keypair.identity),
    ).rejects.toThrow("Vault file not found");
  });
});

// ---------------------------------------------------------------------------
// resolveVaultFilePath
// ---------------------------------------------------------------------------

describe("resolveVaultFilePath", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("uses OPENCLAW_VAULT_PATH env when set", () => {
    const result = resolveVaultFilePath(
      {},
      { ...process.env, OPENCLAW_VAULT_PATH: "/custom/vault.age" },
    );
    expect(result).toBe("/custom/vault.age");
  });

  it("uses config vault.file when set", () => {
    const result = resolveVaultFilePath(
      { vault: { file: "/config/path/secrets.age" } },
      { ...process.env, OPENCLAW_VAULT_PATH: undefined },
    );
    expect(result).toBe("/config/path/secrets.age");
  });

  it("env var takes precedence over config vault.file", () => {
    const result = resolveVaultFilePath(
      { vault: { file: "/config/path/secrets.age" } },
      { ...process.env, OPENCLAW_VAULT_PATH: "/env/vault.age" },
    );
    expect(result).toBe("/env/vault.age");
  });

  it("defaults to vault.age alongside config path", () => {
    const result = resolveVaultFilePath(
      {},
      {
        ...process.env,
        OPENCLAW_VAULT_PATH: undefined,
        OPENCLAW_CONFIG_PATH: "/test/dir/openclaw.json",
      },
    );
    expect(result).toBe("/test/dir/vault.age");
  });
});

// ---------------------------------------------------------------------------
// resolveAgeSecretKey
// ---------------------------------------------------------------------------

describe("resolveAgeSecretKey", () => {
  it("returns env var value when AGE_SECRET_KEY is set", async () => {
    const result = await resolveAgeSecretKey({ AGE_SECRET_KEY: "AGE-SECRET-KEY-1TEST" }, false);
    expect(result).toBe("AGE-SECRET-KEY-1TEST");
  });

  it("throws when no env var and not TTY", async () => {
    await expect(resolveAgeSecretKey({}, false)).rejects.toThrow("AGE_SECRET_KEY not available");
  });

  it("trims whitespace from env var", async () => {
    const result = await resolveAgeSecretKey({ AGE_SECRET_KEY: "  AGE-SECRET-KEY-1TEST  " }, false);
    expect(result).toBe("AGE-SECRET-KEY-1TEST");
  });

  it("deletes AGE_SECRET_KEY from env after reading", async () => {
    const env: NodeJS.ProcessEnv = { AGE_SECRET_KEY: "AGE-SECRET-KEY-1TEST" };
    await resolveAgeSecretKey(env, false);
    expect(env.AGE_SECRET_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider registry helpers
// ---------------------------------------------------------------------------

describe("providerSecretName", () => {
  it("returns secret name for known providers", () => {
    expect(providerSecretName("openai")).toBe("OPENAI_API_KEY");
    expect(providerSecretName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerSecretName("google")).toBe("GEMINI_API_KEY");
  });

  it("is case-insensitive", () => {
    expect(providerSecretName("OpenAI")).toBe("OPENAI_API_KEY");
  });

  it("returns undefined for unknown providers", () => {
    expect(providerSecretName("ollama")).toBeUndefined();
  });
});

describe("providerProxyUrl", () => {
  it("returns default proxy URL for known providers", () => {
    expect(providerProxyUrl("openai")).toBe("http://vault:8081");
    expect(providerProxyUrl("anthropic")).toBe("http://vault:8082");
  });

  it("uses custom proxy host", () => {
    expect(providerProxyUrl("openai", "custom-host")).toBe("http://custom-host:8081");
  });

  it("returns undefined for unknown providers", () => {
    expect(providerProxyUrl("ollama")).toBeUndefined();
  });
});

describe("VAULT_PROVIDER_DEFAULTS", () => {
  it("has entries matching nginx.conf.template ports", () => {
    expect(VAULT_PROVIDER_DEFAULTS.openai.port).toBe(8081);
    expect(VAULT_PROVIDER_DEFAULTS.anthropic.port).toBe(8082);
    expect(VAULT_PROVIDER_DEFAULTS.deepgram.port).toBe(8083);
    expect(VAULT_PROVIDER_DEFAULTS["openai-compat"].port).toBe(8084);
    expect(VAULT_PROVIDER_DEFAULTS.google.port).toBe(8085);
    expect(VAULT_PROVIDER_DEFAULTS.groq.port).toBe(8086);
    expect(VAULT_PROVIDER_DEFAULTS.xai.port).toBe(8087);
    expect(VAULT_PROVIDER_DEFAULTS.mistral.port).toBe(8088);
    expect(VAULT_PROVIDER_DEFAULTS.brave.port).toBe(8089);
    expect(VAULT_PROVIDER_DEFAULTS.perplexity.port).toBe(8090);
  });

  it("has correct secret names for new providers", () => {
    expect(VAULT_PROVIDER_DEFAULTS.groq.secretName).toBe("GROQ_API_KEY");
    expect(VAULT_PROVIDER_DEFAULTS.xai.secretName).toBe("XAI_API_KEY");
    expect(VAULT_PROVIDER_DEFAULTS.mistral.secretName).toBe("MISTRAL_API_KEY");
    expect(VAULT_PROVIDER_DEFAULTS.brave.secretName).toBe("BRAVE_API_KEY");
    expect(VAULT_PROVIDER_DEFAULTS.perplexity.secretName).toBe("PERPLEXITY_API_KEY");
  });

  it("has no duplicate ports", () => {
    const ports = Object.values(VAULT_PROVIDER_DEFAULTS).map((e) => e.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("has no duplicate secret names", () => {
    const names = Object.values(VAULT_PROVIDER_DEFAULTS).map((e) => e.secretName);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// providerProxyUrl hostname validation
// ---------------------------------------------------------------------------

describe("providerProxyUrl hostname validation", () => {
  it("accepts valid hostnames", () => {
    expect(providerProxyUrl("openai", "vault")).toBe("http://vault:8081");
    expect(providerProxyUrl("openai", "my-vault.local")).toBe("http://my-vault.local:8081");
    expect(providerProxyUrl("openai", "host_name")).toBe("http://host_name:8081");
    expect(providerProxyUrl("openai", "192.168.1.1")).toBe("http://192.168.1.1:8081");
  });

  it("rejects hostnames with path components (SSRF prevention)", () => {
    expect(() => providerProxyUrl("openai", "attacker.com/path#")).toThrow(
      "Invalid proxy hostname",
    );
  });

  it("rejects hostnames starting with non-alphanumeric characters", () => {
    expect(() => providerProxyUrl("openai", "-bad-host")).toThrow("Invalid proxy hostname");
    expect(() => providerProxyUrl("openai", ".bad-host")).toThrow("Invalid proxy hostname");
  });

  it("rejects empty hostnames", () => {
    expect(() => providerProxyUrl("openai", "")).toThrow("Invalid proxy hostname");
  });

  it("rejects hostnames with spaces", () => {
    expect(() => providerProxyUrl("openai", "host name")).toThrow("Invalid proxy hostname");
  });
});

// ---------------------------------------------------------------------------
// buildDefaultProxyMap
// ---------------------------------------------------------------------------

describe("buildDefaultProxyMap", () => {
  it("builds proxy URLs for all known providers", () => {
    const proxies = buildDefaultProxyMap();
    const providerCount = Object.keys(VAULT_PROVIDER_DEFAULTS).length;
    expect(Object.keys(proxies).length).toBe(providerCount);
    expect(proxies.openai).toBe("http://vault:8081");
    expect(proxies.anthropic).toBe("http://vault:8082");
  });

  it("uses custom proxy host", () => {
    const proxies = buildDefaultProxyMap("custom-host");
    expect(proxies.openai).toBe("http://custom-host:8081");
  });
});

// ---------------------------------------------------------------------------
// findProviderBySecretName
// ---------------------------------------------------------------------------

describe("findProviderBySecretName", () => {
  it("finds provider by secret name", () => {
    const result = findProviderBySecretName("OPENAI_API_KEY");
    expect(result).toBeDefined();
    expect(result![0]).toBe("openai");
    expect(result![1].port).toBe(8081);
  });

  it("returns undefined for unknown secret names", () => {
    expect(findProviderBySecretName("UNKNOWN_KEY")).toBeUndefined();
  });
});
