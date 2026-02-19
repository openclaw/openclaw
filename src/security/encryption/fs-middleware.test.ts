import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptString, isEncrypted } from "./crypto.js";
import {
  clearActiveKeys,
  getActiveConfigKey,
  getActiveWorkspaceKey,
  readConfigAutoDecrypt,
  readFileAutoDecrypt,
  setActiveKeys,
  writeConfigAutoEncrypt,
  writeFileAutoEncrypt,
} from "./fs-middleware.js";

const WORKSPACE_KEY = crypto.randomBytes(32);
const CONFIG_KEY = crypto.randomBytes(32);
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fsmw-test-"));
  clearActiveKeys();
});

afterEach(async () => {
  clearActiveKeys();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("setActiveKeys / getActiveKeys", () => {
  it("stores and retrieves keys", () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    expect(getActiveWorkspaceKey()).toBe(WORKSPACE_KEY);
    expect(getActiveConfigKey()).toBe(CONFIG_KEY);
  });

  it("clears keys", () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    clearActiveKeys();
    expect(getActiveWorkspaceKey()).toBeNull();
    expect(getActiveConfigKey()).toBeNull();
  });
});

describe("readFileAutoDecrypt", () => {
  it("reads plaintext when no keys set", async () => {
    const fp = path.join(tmpDir, "plain.md");
    await fs.writeFile(fp, "hello");
    expect(await readFileAutoDecrypt(fp)).toBe("hello");
  });

  it("reads plaintext when keys are set but file is not encrypted", async () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    const fp = path.join(tmpDir, "plain.md");
    await fs.writeFile(fp, "still plain");
    expect(await readFileAutoDecrypt(fp)).toBe("still plain");
  });

  it("decrypts encrypted file when keys are set", async () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    const fp = path.join(tmpDir, "encrypted.md");
    await fs.writeFile(fp, encryptString("secret", WORKSPACE_KEY));
    expect(await readFileAutoDecrypt(fp)).toBe("secret");
  });
});

describe("writeFileAutoEncrypt", () => {
  it("writes plaintext when no keys set", async () => {
    const fp = path.join(tmpDir, "out.md");
    await writeFileAutoEncrypt(fp, "plain write");
    const raw = await fs.readFile(fp, "utf-8");
    expect(raw).toBe("plain write");
  });

  it("writes encrypted when keys are set", async () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    const fp = path.join(tmpDir, "out.md");
    await writeFileAutoEncrypt(fp, "encrypted write");
    const raw = await fs.readFile(fp);
    expect(isEncrypted(raw)).toBe(true);
  });

  it("round-trips through write then read", async () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    const fp = path.join(tmpDir, "round.md");
    await writeFileAutoEncrypt(fp, "round trip data");
    expect(await readFileAutoDecrypt(fp)).toBe("round trip data");
  });
});

describe("config key operations", () => {
  it("reads config with config key", async () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    const fp = path.join(tmpDir, "config.yaml");
    await fs.writeFile(fp, encryptString("config: true", CONFIG_KEY));
    expect(await readConfigAutoDecrypt(fp)).toBe("config: true");
  });

  it("writes config encrypted with config key", async () => {
    setActiveKeys(WORKSPACE_KEY, CONFIG_KEY);
    const fp = path.join(tmpDir, "config.yaml");
    await writeConfigAutoEncrypt(fp, "config: encrypted");
    const raw = await fs.readFile(fp);
    expect(isEncrypted(raw)).toBe(true);
  });
});
