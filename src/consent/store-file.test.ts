import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileBackedTokenStore } from "./store-file.js";
import type { ConsentToken } from "./types.js";

function makeToken(overrides: Partial<ConsentToken> = {}): ConsentToken {
  return {
    jti: "test-jti-1",
    status: "issued",
    tool: "exec",
    trustTier: "T0",
    sessionKey: "session-1",
    contextHash: "ctx-1",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    issuedBy: "test",
    policyVersion: "1",
    ...overrides,
  };
}

describe("file-backed token store", () => {
  it("persists token and returns it after put/get", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-store-"));
    try {
      const store = createFileBackedTokenStore(dir);
      const token = makeToken({ jti: "jti-a" });
      store.put(token);
      expect(store.get("jti-a")).toBeDefined();
      expect(store.get("jti-a")?.status).toBe("issued");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives new store instance (reload from disk)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-store-"));
    try {
      const store1 = createFileBackedTokenStore(dir);
      store1.put(makeToken({ jti: "jti-b" }));
      const store2 = createFileBackedTokenStore(dir);
      expect(store2.get("jti-b")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transition to consumed and persists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-store-"));
    try {
      const store = createFileBackedTokenStore(dir);
      store.put(makeToken({ jti: "jti-c" }));
      const ok = store.transition("jti-c", "consumed");
      expect(ok).toBe(true);
      expect(store.get("jti-c")?.status).toBe("consumed");
      const store2 = createFileBackedTokenStore(dir);
      expect(store2.get("jti-c")?.status).toBe("consumed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findBySession and list filter correctly", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-store-"));
    try {
      const store = createFileBackedTokenStore(dir);
      store.put(makeToken({ jti: "j1", sessionKey: "sess-a", tenantId: "t1" }));
      store.put(makeToken({ jti: "j2", sessionKey: "sess-a", tenantId: "t1" }));
      store.put(makeToken({ jti: "j3", sessionKey: "sess-b", tenantId: "t1" }));
      expect(store.findBySession("sess-a")).toHaveLength(2);
      expect(store.findBySession("sess-a", "t1")).toHaveLength(2);
      expect(store.findBySession("sess-a", "t2")).toHaveLength(0);
      expect(store.list()).toHaveLength(3);
      expect(store.list("t1")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
