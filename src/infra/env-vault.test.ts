import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVaultAction } from "./env-vault-cli.js";
import { decrypt, encrypt, loadVaultEnv, openVault, resolveVaultConfig } from "./env-vault.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "env-vault-test-"));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const TEST_PASSWORD = "test-master-password-42";

// ---------------------------------------------------------------------------
// encrypt / decrypt
// ---------------------------------------------------------------------------

describe("encrypt/decrypt", () => {
  it("round-trips a string", () => {
    const original = "sk-super-secret-api-key-12345";
    const encrypted = encrypt(original, TEST_PASSWORD);
    const decrypted = decrypt(encrypted, TEST_PASSWORD);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertext each time (random salt/IV)", () => {
    const original = "same-input";
    const a = encrypt(original, TEST_PASSWORD);
    const b = encrypt(original, TEST_PASSWORD);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(decrypt(a, TEST_PASSWORD)).toBe(original);
    expect(decrypt(b, TEST_PASSWORD)).toBe(original);
  });

  it("fails to decrypt with wrong password", () => {
    const encrypted = encrypt("secret", TEST_PASSWORD);
    expect(() => decrypt(encrypted, "wrong-password")).toThrow();
  });

  it("handles empty string", () => {
    const encrypted = encrypt("", TEST_PASSWORD);
    expect(decrypt(encrypted, TEST_PASSWORD)).toBe("");
  });

  it("handles unicode content", () => {
    const original = "API_KEY=sk-\u{1F600}\u{1F4BB}\u{2764}";
    const encrypted = encrypt(original, TEST_PASSWORD);
    expect(decrypt(encrypted, TEST_PASSWORD)).toBe(original);
  });

  it("handles long values", () => {
    const original = "x".repeat(10000);
    const encrypted = encrypt(original, TEST_PASSWORD);
    expect(decrypt(encrypted, TEST_PASSWORD)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// resolveVaultConfig
// ---------------------------------------------------------------------------

describe("resolveVaultConfig", () => {
  it("returns null when OPENCLAW_VAULT_PASSWORD is missing", () => {
    expect(resolveVaultConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null when password is empty/whitespace", () => {
    expect(resolveVaultConfig({ OPENCLAW_VAULT_PASSWORD: "  " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns config when password is set", () => {
    const config = resolveVaultConfig({
      OPENCLAW_VAULT_PASSWORD: "my-password",
    } as NodeJS.ProcessEnv);
    expect(config).not.toBeNull();
    expect(config?.masterPassword).toBe("my-password");
  });

  it("respects OPENCLAW_VAULT_PATH override", () => {
    const config = resolveVaultConfig({
      OPENCLAW_VAULT_PASSWORD: "pw",
      OPENCLAW_VAULT_PATH: "/custom/vault.db",
    } as NodeJS.ProcessEnv);
    expect(config?.vaultPath).toBe("/custom/vault.db");
  });
});

// ---------------------------------------------------------------------------
// openVault — CRUD operations
// ---------------------------------------------------------------------------

describe("openVault", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      cleanupDir(tempDir);
    }
  });

  it("creates vault file if it does not exist", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    expect(fs.existsSync(vaultPath)).toBe(false);

    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });
    vault.close();

    expect(fs.existsSync(vaultPath)).toBe(true);
  });

  it("set + get round-trips a secret", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });

    vault.set("OPENAI_API_KEY", "sk-test-123");
    expect(vault.get("OPENAI_API_KEY")).toBe("sk-test-123");

    vault.close();
  });

  it("set overwrites existing value", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });

    vault.set("KEY", "v1");
    vault.set("KEY", "v2");
    expect(vault.get("KEY")).toBe("v2");

    vault.close();
  });

  it("get returns null for missing key", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });

    expect(vault.get("NONEXISTENT")).toBeNull();

    vault.close();
  });

  it("listKeys returns all stored keys", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });

    vault.set("B_KEY", "val");
    vault.set("A_KEY", "val");
    vault.set("C_KEY", "val");

    const keys = vault.listKeys();
    expect(keys).toEqual(["A_KEY", "B_KEY", "C_KEY"]);

    vault.close();
  });

  it("getAll returns all decrypted entries", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });

    vault.set("KEY_A", "value-a");
    vault.set("KEY_B", "value-b");

    const entries = vault.getAll();
    expect(entries).toEqual([
      { key: "KEY_A", value: "value-a" },
      { key: "KEY_B", value: "value-b" },
    ]);

    vault.close();
  });

  it("remove deletes a key", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });

    vault.set("TO_DELETE", "val");
    expect(vault.remove("TO_DELETE")).toBe(true);
    expect(vault.get("TO_DELETE")).toBeNull();
    expect(vault.remove("TO_DELETE")).toBe(false);

    vault.close();
  });

  it("persists across open/close cycles", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");

    const v1 = openVault({ masterPassword: TEST_PASSWORD, vaultPath });
    v1.set("PERSISTENT", "still-here");
    v1.close();

    const v2 = openVault({ masterPassword: TEST_PASSWORD, vaultPath });
    expect(v2.get("PERSISTENT")).toBe("still-here");
    v2.close();
  });

  it("wrong password cannot decrypt values from a different password", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");

    const v1 = openVault({ masterPassword: "password-1", vaultPath });
    v1.set("SECRET", "my-secret");
    v1.close();

    const v2 = openVault({ masterPassword: "password-2", vaultPath });
    // get() catches decryption failures and returns null
    expect(v2.get("SECRET")).toBeNull();
    v2.close();
  });
});

// ---------------------------------------------------------------------------
// loadVaultEnv — startup integration
// ---------------------------------------------------------------------------

describe("loadVaultEnv", () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const keysToClean: string[] = [];

  function saveKey(key: string): void {
    savedEnv[key] = process.env[key];
    keysToClean.push(key);
  }

  afterEach(() => {
    for (const key of keysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    keysToClean.length = 0;
    if (tempDir) {
      cleanupDir(tempDir);
    }
  });

  it("returns 0 when OPENCLAW_VAULT_PASSWORD is not set", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadVaultEnv({ env })).toBe(0);
  });

  it("returns 0 when vault file does not exist", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_VAULT_PASSWORD: TEST_PASSWORD,
      OPENCLAW_VAULT_PATH: "/nonexistent/vault.db",
    };
    expect(loadVaultEnv({ env })).toBe(0);
  });

  it("loads vault secrets into env object", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");

    // Pre-populate the vault
    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });
    vault.set("VAULT_SECRET_A", "value-a");
    vault.set("VAULT_SECRET_B", "value-b");
    vault.close();

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_VAULT_PASSWORD: TEST_PASSWORD,
      OPENCLAW_VAULT_PATH: vaultPath,
    };

    const applied = loadVaultEnv({ env });
    expect(applied).toBe(2);
    expect(env.VAULT_SECRET_A).toBe("value-a");
    expect(env.VAULT_SECRET_B).toBe("value-b");
  });

  it("does not override existing non-empty env vars", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");

    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });
    vault.set("EXISTING", "from-vault");
    vault.set("NEW_KEY", "from-vault");
    vault.close();

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_VAULT_PASSWORD: TEST_PASSWORD,
      OPENCLAW_VAULT_PATH: vaultPath,
      EXISTING: "original-value",
    };

    const applied = loadVaultEnv({ env });
    expect(applied).toBe(1);
    expect(env.EXISTING).toBe("original-value");
    expect(env.NEW_KEY).toBe("from-vault");
  });

  it("works with process.env", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");

    const vault = openVault({ masterPassword: TEST_PASSWORD, vaultPath });
    vault.set("VAULT_PROCESS_TEST", "injected");
    vault.close();

    saveKey("OPENCLAW_VAULT_PASSWORD");
    saveKey("OPENCLAW_VAULT_PATH");
    saveKey("VAULT_PROCESS_TEST");

    process.env.OPENCLAW_VAULT_PASSWORD = TEST_PASSWORD;
    process.env.OPENCLAW_VAULT_PATH = vaultPath;
    delete process.env.VAULT_PROCESS_TEST;

    const applied = loadVaultEnv();
    expect(applied).toBe(1);
    expect(process.env.VAULT_PROCESS_TEST).toBe("injected");
  });
});

// ---------------------------------------------------------------------------
// runVaultAction — CLI helper
// ---------------------------------------------------------------------------

describe("runVaultAction", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      cleanupDir(tempDir);
    }
  });

  it("set + get", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const opts = { masterPassword: TEST_PASSWORD, vaultPath };

    const setResult = runVaultAction({ action: "set", key: "MY_KEY", value: "my-val" }, opts);
    expect(setResult).toBe("Stored: MY_KEY");

    const getResult = runVaultAction({ action: "get", key: "MY_KEY" }, opts);
    expect(getResult).toBe("my-val");
  });

  it("list", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const opts = { masterPassword: TEST_PASSWORD, vaultPath };

    expect(runVaultAction({ action: "list" }, opts)).toBe("Vault is empty.");

    runVaultAction({ action: "set", key: "B", value: "x" }, opts);
    runVaultAction({ action: "set", key: "A", value: "x" }, opts);

    expect(runVaultAction({ action: "list" }, opts)).toBe("A\nB");
  });

  it("remove", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const opts = { masterPassword: TEST_PASSWORD, vaultPath };

    runVaultAction({ action: "set", key: "K", value: "v" }, opts);
    expect(runVaultAction({ action: "remove", key: "K" }, opts)).toBe("Removed: K");
    expect(runVaultAction({ action: "remove", key: "K" }, opts)).toBe("Key not found: K");
  });

  it("get missing key", () => {
    tempDir = makeTempDir();
    const vaultPath = path.join(tempDir, "vault.db");
    const opts = { masterPassword: TEST_PASSWORD, vaultPath };

    expect(runVaultAction({ action: "get", key: "NOPE" }, opts)).toBe("Key not found: NOPE");
  });
});
