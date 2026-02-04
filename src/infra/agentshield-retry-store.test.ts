import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentShieldRetryStore, argsFingerprint } from "./agentshield-retry-store.js";

describe("argsFingerprint", () => {
  it("returns a 64-char hex SHA-256", () => {
    const fp = argsFingerprint("test");
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(argsFingerprint("abc")).toBe(argsFingerprint("abc"));
  });
});

describe("AgentShieldRetryStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "as-retry-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store/load roundtrip", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    const fp = store.store("entry-1", "shell_exec", { cmd: "ls -la" }, { agentId: "a1" });
    expect(typeof fp).toBe("string");
    expect(fp).toHaveLength(64);

    const data = store.load("entry-1");
    expect(data.toolName).toBe("shell_exec");
    expect(data.params).toEqual({ cmd: "ls -la" });
    expect(data.ctx).toEqual({ agentId: "a1" });
  });

  it("stores encrypted data (raw args not visible)", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    store.store("enc-1", "secret_tool", { password: "hunter2" });
    const encPath = path.join(tmpDir, "agentshield-retries", "enc-1.enc");
    expect(fs.existsSync(encPath)).toBe(true);
    const raw = fs.readFileSync(encPath);
    expect(raw.includes(Buffer.from("hunter2"))).toBe(false);
    expect(raw.includes(Buffer.from("secret_tool"))).toBe(false);
  });

  it("file permissions are 0o600", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    store.store("perm-1", "tool", { x: 1 });
    const encPath = path.join(tmpDir, "agentshield-retries", "perm-1.enc");
    const stat = fs.statSync(encPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("key file permissions are 0o600", () => {
    new AgentShieldRetryStore(tmpDir);
    const keyPath = path.join(tmpDir, "agentshield-retries", ".key");
    expect(fs.existsSync(keyPath)).toBe(true);
    const stat = fs.statSync(keyPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("key is 32 bytes", () => {
    new AgentShieldRetryStore(tmpDir);
    const keyPath = path.join(tmpDir, "agentshield-retries", ".key");
    const key = fs.readFileSync(keyPath);
    expect(key.length).toBe(32);
  });

  it("key reuse across instances", () => {
    const s1 = new AgentShieldRetryStore(tmpDir);
    s1.store("reuse-1", "tool", { x: 1 });
    const s2 = new AgentShieldRetryStore(tmpDir);
    const data = s2.load("reuse-1");
    expect(data.params).toEqual({ x: 1 });
  });

  it("remove", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    store.store("rm-1", "t", {});
    expect(store.remove("rm-1")).toBe(true);
    expect(store.remove("rm-1")).toBe(false);
  });

  it("listIds", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    store.store("c", "t", {});
    store.store("a", "t", {});
    store.store("b", "t", {});
    expect(store.listIds()).toEqual(["a", "b", "c"]);
  });

  it("listIds empty", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    expect(store.listIds()).toEqual([]);
  });

  it("load nonexistent throws", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    expect(() => store.load("nope")).toThrow("retry entry not found");
  });

  it("load corrupted throws", () => {
    const store = new AgentShieldRetryStore(tmpDir);
    const encPath = path.join(tmpDir, "agentshield-retries", "corrupt.enc");
    fs.writeFileSync(encPath, "garbage-data-not-encrypted");
    expect(() => store.load("corrupt")).toThrow();
  });
});
