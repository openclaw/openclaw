import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { AgentShieldRetryStore, argsFingerprint } from "./agentshield-retry-store.js";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agentshield-retry-"));
}

describe("AgentShieldRetryStore", () => {
  it("stores and loads encrypted entries", () => {
    const tmpDir = mkTmp();
    const store = new AgentShieldRetryStore(tmpDir);

    const paramsJSON = JSON.stringify({ cmd: "ls -la" });
    const fp = store.store("entry-1", "shell_exec", paramsJSON, { agentId: "a1" });

    expect(fp).toBe(argsFingerprint(paramsJSON));

    const loaded = store.load("entry-1");
    expect(loaded.toolName).toBe("shell_exec");
    expect(loaded.paramsJSON).toBe(paramsJSON);
    expect(loaded.ctx).toEqual({ agentId: "a1" });
  });

  it("writes encrypted file to disk (not plaintext JSON)", () => {
    const tmpDir = mkTmp();
    const store = new AgentShieldRetryStore(tmpDir);

    const paramsJSON = JSON.stringify({ password: "hunter2" });
    store.store("enc-1", "secret_tool", paramsJSON);

    const encPath = path.join(tmpDir, "agentshield-retries", "enc-1.enc");
    const raw = fs.readFileSync(encPath);

    // Very lightweight check: encrypted blob should not contain obvious plaintext fields
    expect(raw.toString("utf8")).not.toContain("hunter2");
    expect(raw.toString("utf8")).not.toContain("secret_tool");
    expect(raw.toString("utf8")).not.toContain("paramsJSON");
  });

  it("persists key and can read entries across instances", () => {
    const tmpDir = mkTmp();

    const s1 = new AgentShieldRetryStore(tmpDir);
    const paramsJSON = JSON.stringify({ x: 1 });
    s1.store("reuse-1", "tool", paramsJSON);

    const s2 = new AgentShieldRetryStore(tmpDir);
    const loaded = s2.load("reuse-1");
    expect(loaded.toolName).toBe("tool");
    expect(loaded.paramsJSON).toBe(paramsJSON);
  });

  it("remove() deletes an entry", () => {
    const tmpDir = mkTmp();
    const store = new AgentShieldRetryStore(tmpDir);

    store.store("rm-1", "t", JSON.stringify({}));
    expect(store.remove("rm-1")).toBe(true);
    expect(() => store.load("rm-1")).toThrow();
    expect(store.remove("rm-1")).toBe(false);
  });

  it("listIds() returns sorted ids", () => {
    const tmpDir = mkTmp();
    const store = new AgentShieldRetryStore(tmpDir);

    store.store("c", "t", JSON.stringify({}));
    store.store("a", "t", JSON.stringify({}));
    store.store("b", "t", JSON.stringify({}));

    expect(store.listIds()).toEqual(["a", "b", "c"]);
  });

  it("throws if entry missing", () => {
    const tmpDir = mkTmp();
    const store = new AgentShieldRetryStore(tmpDir);
    expect(() => store.load("missing")).toThrow(/retry entry not found/);
  });

  it("throws on corrupt ciphertext", () => {
    const tmpDir = mkTmp();
    const store = new AgentShieldRetryStore(tmpDir);

    const encPath = path.join(tmpDir, "agentshield-retries", "corrupt.enc");
    fs.writeFileSync(encPath, Buffer.from("not-valid"), { mode: 0o600 });

    expect(() => store.load("corrupt")).toThrow();
  });
});
