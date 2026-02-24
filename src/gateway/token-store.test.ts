import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isTokenRevoked,
  loadTokenStore,
  pruneExpiredTokens,
  recordTokenMetadata,
  revokeAllTokens,
  revokeToken,
  saveTokenStore,
  type TokenMetadata,
  type TokenStore,
} from "./token-store.js";

describe("token-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMeta(overrides?: Partial<TokenMetadata>): TokenMetadata {
    return {
      jti: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      subject: "test-subject",
      role: "operator",
      scopes: ["operator.read"],
      issuedAt: Math.floor(Date.now() / 1000),
      ...overrides,
    };
  }

  it("loads empty store when file does not exist", () => {
    const store = loadTokenStore(tmpDir);
    expect(store.version).toBe(1);
    expect(store.tokens).toEqual({});
  });

  it("saves and loads token store round-trip", () => {
    const meta = makeMeta({ jti: "abc123" });
    let store = loadTokenStore(tmpDir);
    store = recordTokenMetadata(store, meta);
    saveTokenStore(store, tmpDir);

    const loaded = loadTokenStore(tmpDir);
    expect(loaded.tokens["abc123"]).toBeDefined();
    expect(loaded.tokens["abc123"].subject).toBe("test-subject");
  });

  it("revoke token sets revokedAt", () => {
    const meta = makeMeta({ jti: "revoke-me" });
    let store: TokenStore = { version: 1, tokens: {} };
    store = recordTokenMetadata(store, meta);
    expect(isTokenRevoked(store, "revoke-me")).toBe(false);

    store = revokeToken(store, "revoke-me");
    expect(isTokenRevoked(store, "revoke-me")).toBe(true);
    expect(store.tokens["revoke-me"].revokedAt).toBeTypeOf("number");
  });

  it("revoke all tokens", () => {
    let store: TokenStore = { version: 1, tokens: {} };
    store = recordTokenMetadata(store, makeMeta({ jti: "a" }));
    store = recordTokenMetadata(store, makeMeta({ jti: "b" }));
    store = recordTokenMetadata(store, makeMeta({ jti: "c" }));

    store = revokeAllTokens(store);
    expect(isTokenRevoked(store, "a")).toBe(true);
    expect(isTokenRevoked(store, "b")).toBe(true);
    expect(isTokenRevoked(store, "c")).toBe(true);
  });

  it("prune expired tokens removes expired+revoked entries", () => {
    const now = Math.floor(Date.now() / 1000);
    let store: TokenStore = { version: 1, tokens: {} };

    // Expired AND revoked — should be pruned
    store = recordTokenMetadata(
      store,
      makeMeta({
        jti: "expired-revoked",
        expiresAt: now - 100,
        revokedAt: now - 50,
      }),
    );

    // Expired but NOT revoked — should be kept (still useful for audit)
    store = recordTokenMetadata(
      store,
      makeMeta({
        jti: "expired-only",
        expiresAt: now - 100,
      }),
    );

    // Active — should be kept
    store = recordTokenMetadata(
      store,
      makeMeta({
        jti: "active",
        expiresAt: now + 3600,
      }),
    );

    store = pruneExpiredTokens(store, now);
    expect(store.tokens["expired-revoked"]).toBeUndefined();
    expect(store.tokens["expired-only"]).toBeDefined();
    expect(store.tokens["active"]).toBeDefined();
  });

  it("isTokenRevoked returns false for unknown jti", () => {
    const store: TokenStore = { version: 1, tokens: {} };
    expect(isTokenRevoked(store, "nonexistent")).toBe(false);
  });

  it("store file has restricted permissions (0o600)", () => {
    const store = loadTokenStore(tmpDir);
    saveTokenStore(store, tmpDir);
    const storePath = path.join(tmpDir, "identity", "token-store.json");
    const stat = fs.statSync(storePath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
