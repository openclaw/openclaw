import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EnvKeyProvider, FileKeyProvider, createKeyProvider } from "./key-management.js";

describe("EnvKeyProvider", () => {
  const TEST_ENV_VAR = "TEST_OPENCLAW_KEY";

  afterEach(() => {
    delete process.env[TEST_ENV_VAR];
  });

  it("should use environment variable with hex key", async () => {
    const hexKey = "a".repeat(64); // 64 hex chars = 32 bytes
    process.env[TEST_ENV_VAR] = hexKey;

    const provider = new EnvKeyProvider(TEST_ENV_VAR);
    const key = await provider.getKey();

    expect(key).toEqual(Buffer.from(hexKey, "hex"));
  });

  it("should throw for non-hex string", async () => {
    process.env[TEST_ENV_VAR] = "my-secret-password";

    const provider = new EnvKeyProvider(TEST_ENV_VAR);
    await expect(provider.getKey()).rejects.toThrow(
      "TEST_OPENCLAW_KEY must be a 64-character hex string (32 bytes)",
    );
  });

  it("should throw when env var not set", async () => {
    const provider = new EnvKeyProvider("NONEXISTENT_VAR");
    await expect(provider.getKey()).rejects.toThrow("Environment variable NONEXISTENT_VAR not set");
  });

  it("should check availability correctly", async () => {
    const provider = new EnvKeyProvider(TEST_ENV_VAR);

    expect(await provider.isAvailable()).toBe(false);

    process.env[TEST_ENV_VAR] = "test-value";
    expect(await provider.isAvailable()).toBe(true);
  });

  it("should generate consistent keys from same hex key", async () => {
    const hexKey = "b".repeat(64); // 64 hex chars = 32 bytes
    process.env[TEST_ENV_VAR] = hexKey;

    const provider1 = new EnvKeyProvider(TEST_ENV_VAR);
    const provider2 = new EnvKeyProvider(TEST_ENV_VAR);

    const key1 = await provider1.getKey();
    const key2 = await provider2.getKey();

    expect(key1).toEqual(key2);
    expect(key1).toEqual(Buffer.from(hexKey, "hex"));
  });
});

describe("FileKeyProvider", () => {
  let tempDir: string;
  let keyPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    keyPath = path.join(tempDir, "test.key");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it("should generate and store new key", async () => {
    const provider = new FileKeyProvider(keyPath);
    const key = await provider.getKey();

    expect(key).toHaveLength(32);
    expect(fs.existsSync(keyPath)).toBe(true);

    // Should read same key on subsequent calls
    const key2 = await provider.getKey();
    expect(key2).toEqual(key);
  });

  it("should read existing key file", async () => {
    const testKey = Buffer.from("a".repeat(64), "hex");
    fs.writeFileSync(keyPath, testKey.toString("hex"));

    const provider = new FileKeyProvider(keyPath);
    const key = await provider.getKey();

    expect(key).toEqual(testKey);
  });

  it("should create directory if needed", async () => {
    const nestedPath = path.join(tempDir, "nested", "dirs", "key.txt");
    const provider = new FileKeyProvider(nestedPath);

    expect(await provider.isAvailable()).toBe(true);

    const key = await provider.getKey();
    expect(key).toHaveLength(32);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("should set secure file permissions", async () => {
    const provider = new FileKeyProvider(keyPath);
    await provider.getKey();

    const stats = fs.statSync(keyPath);
    // Check that file is readable/writable by owner only (600)
    // Note: Windows doesn't support Unix-style file permissions
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe("createKeyProvider", () => {
  let tempDir: string;
  const TEST_ENV_VAR = "TEST_OPENCLAW_KEY";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
  });

  afterEach(() => {
    delete process.env[TEST_ENV_VAR];
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it("should prefer environment variable when available", async () => {
    process.env.OPENCLAW_ENCRYPTION_KEY = "test-key-from-env";

    const provider = await createKeyProvider({
      keyPath: path.join(tempDir, "should-not-be-used.key"),
    });

    expect(provider).toBeInstanceOf(EnvKeyProvider);
  });

  it("should fall back to file provider when env not available", async () => {
    // Ensure env var is not set
    delete process.env.OPENCLAW_ENCRYPTION_KEY;

    const keyPath = path.join(tempDir, "fallback.key");
    const provider = await createKeyProvider({ keyPath });

    expect(provider).toBeInstanceOf(FileKeyProvider);
    expect(await provider.isAvailable()).toBe(true);
  });

  it("should use custom environment variable name", async () => {
    process.env[TEST_ENV_VAR] = "custom-env-key";

    const provider = await createKeyProvider({ envVar: TEST_ENV_VAR });

    expect(provider).toBeInstanceOf(EnvKeyProvider);
  });
});
