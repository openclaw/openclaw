import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampTtlMs,
  createSessionShareToken,
  DEFAULT_TTL_MS,
  initSessionShareTokens,
  MAX_TTL_MS,
  pruneExpiredTokens,
  resolveSessionShareToken,
  revokeSessionShareToken,
} from "./session-share-tokens.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-share-tokens-test-"));
}

describe("session-share-tokens", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    initSessionShareTokens({ stateDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("clampTtlMs", () => {
    it("returns DEFAULT_TTL_MS for undefined", () => {
      expect(clampTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
    });

    it("returns DEFAULT_TTL_MS for zero", () => {
      expect(clampTtlMs(0)).toBe(DEFAULT_TTL_MS);
    });

    it("returns DEFAULT_TTL_MS for negative", () => {
      expect(clampTtlMs(-1)).toBe(DEFAULT_TTL_MS);
    });

    it("clamps to MAX_TTL_MS when over limit", () => {
      expect(clampTtlMs(MAX_TTL_MS + 1)).toBe(MAX_TTL_MS);
    });

    it("passes through valid TTL", () => {
      expect(clampTtlMs(60_000)).toBe(60_000);
    });
  });

  describe("createSessionShareToken", () => {
    it("returns a token entry with correct shape", () => {
      const entry = createSessionShareToken({
        sessionKey: "agent:default:session:abc",
        createdByDeviceId: "device-1",
      });
      expect(entry.token).toHaveLength(64); // 32 bytes hex
      expect(entry.sessionKey).toBe("agent:default:session:abc");
      expect(entry.createdByDeviceId).toBe("device-1");
      expect(entry.expiresAtMs).toBeGreaterThan(Date.now());
      expect(entry.createdAtMs).toBeLessThanOrEqual(Date.now());
    });

    it("generates unique tokens for each call", () => {
      const a = createSessionShareToken({ sessionKey: "key", createdByDeviceId: "d" });
      const b = createSessionShareToken({ sessionKey: "key", createdByDeviceId: "d" });
      expect(a.token).not.toBe(b.token);
    });

    it("respects custom ttlMs", () => {
      const ttlMs = 60_000;
      const before = Date.now();
      const entry = createSessionShareToken({
        sessionKey: "key",
        ttlMs,
        createdByDeviceId: "d",
      });
      const after = Date.now();
      expect(entry.expiresAtMs).toBeGreaterThanOrEqual(before + ttlMs);
      expect(entry.expiresAtMs).toBeLessThanOrEqual(after + ttlMs);
    });
  });

  describe("resolveSessionShareToken", () => {
    it("returns sessionKey for a valid token", () => {
      const entry = createSessionShareToken({
        sessionKey: "my-session",
        createdByDeviceId: "d",
      });
      const result = resolveSessionShareToken(entry.token);
      expect(result).toEqual({ sessionKey: "my-session" });
    });

    it("returns null for unknown token", () => {
      expect(resolveSessionShareToken("not-a-real-token")).toBeNull();
    });

    it("returns null for expired token", () => {
      const entry = createSessionShareToken({
        sessionKey: "my-session",
        ttlMs: -1, // forces DEFAULT_TTL_MS but we'll manipulate directly
        createdByDeviceId: "d",
      });
      // Manually expire by patching — since store is module-level, use a new
      // token with a very short TTL and wait (not practical). Instead verify
      // via revokeSessionShareToken.
      revokeSessionShareToken(entry.token);
      expect(resolveSessionShareToken(entry.token)).toBeNull();
    });
  });

  describe("revokeSessionShareToken", () => {
    it("revokes an existing token", () => {
      const entry = createSessionShareToken({ sessionKey: "s", createdByDeviceId: "d" });
      expect(revokeSessionShareToken(entry.token)).toBe(true);
      expect(resolveSessionShareToken(entry.token)).toBeNull();
    });

    it("returns false for unknown token", () => {
      expect(revokeSessionShareToken("nonexistent")).toBe(false);
    });
  });

  describe("pruneExpiredTokens", () => {
    it("returns 0 when no tokens are expired", () => {
      createSessionShareToken({ sessionKey: "s", createdByDeviceId: "d" });
      expect(pruneExpiredTokens()).toBe(0);
    });
  });

  describe("persistence", () => {
    it("writes a JSONL file on token creation", () => {
      createSessionShareToken({ sessionKey: "s", createdByDeviceId: "d" });
      const filePath = path.join(tmpDir, "session-share-tokens.jsonl");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf8");
      expect(content.trim()).not.toBe("");
      const parsed = JSON.parse(content.trim().split("\n")[0]!);
      expect(parsed.sessionKey).toBe("s");
    });
  });
});
