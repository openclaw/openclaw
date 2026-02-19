import { describe, expect, it } from "vitest";
import { createConsentEngine } from "./engine.js";
import { CONSENT_REASON } from "./reason-codes.js";
import { buildToken, createInMemoryTokenStore } from "./store.js";
import { createInMemoryWal } from "./wal.js";

describe("ConsentGate engine", () => {
  const policyVersion = "1";

  function createEngine() {
    return createConsentEngine({
      store: createInMemoryTokenStore(),
      wal: createInMemoryWal(),
      policyVersion,
    });
  }

  it("issues a token and consume allows once", async () => {
    const api = createEngine();
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).not.toBeNull();
    expect(token?.jti).toBeDefined();
    expect(token?.status).toBe("issued");

    const consume1 = await api.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
    });
    expect(consume1.allowed).toBe(true);

    const consume2 = await api.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
    });
    expect(consume2.allowed).toBe(false);
    if (!consume2.allowed) {
      expect(consume2.reasonCode).toBe(CONSENT_REASON.TOKEN_ALREADY_CONSUMED);
    }
  });

  it("denies consume when token not found", async () => {
    const api = createEngine();
    const result = await api.consume({
      jti: "nonexistent",
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "x",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe(CONSENT_REASON.TOKEN_NOT_FOUND);
    }
  });

  it("denies consume when jti is missing", async () => {
    const api = createEngine();
    const result = await api.consume({
      jti: "",
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "x",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe(CONSENT_REASON.NO_TOKEN);
    }
  });

  it("denies consume when context hash mismatch", async () => {
    const api = createEngine();
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).not.toBeNull();

    const result = await api.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "different",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe(CONSENT_REASON.CONTEXT_MISMATCH);
    }
  });

  it("denies consume when trust tier mismatches token", async () => {
    const api = createEngine();
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).not.toBeNull();

    const result = await api.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T1",
      sessionKey: "main",
      contextHash: "abc",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe(CONSENT_REASON.TIER_VIOLATION);
    }
  });

  it("denies consume when token expired", async () => {
    const api = createEngine();
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
      ttlMs: 1,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await api.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "abc",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reasonCode).toBe(CONSENT_REASON.TOKEN_EXPIRED);
    }
  });

  it("evaluate does not consume token", async () => {
    const api = createEngine();
    const token = await api.issue({
      tool: "write",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "h1",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).not.toBeNull();

    const eval1 = await api.evaluate({
      jti: token!.jti,
      tool: "write",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "h1",
    });
    expect(eval1.allowed).toBe(true);

    const consume = await api.consume({
      jti: token!.jti,
      tool: "write",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "h1",
    });
    expect(consume.allowed).toBe(true);

    const consume2 = await api.consume({
      jti: token!.jti,
      tool: "write",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "h1",
    });
    expect(consume2.allowed).toBe(false);
  });

  it("revoke by jti invalidates token", async () => {
    const api = createEngine();
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "x",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).not.toBeNull();

    const revoke = await api.revoke({ jti: token!.jti });
    expect(revoke.revoked).toBe(1);

    const consume = await api.consume({
      jti: token!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "main",
      contextHash: "x",
    });
    expect(consume.allowed).toBe(false);
    if (!consume.allowed) {
      expect(consume.reasonCode).toBe(CONSENT_REASON.TOKEN_REVOKED);
    }
  });

  it("quarantine blocks issue and consume", async () => {
    const store = createInMemoryTokenStore();
    const wal = createInMemoryWal();
    const quarantine = new Set<string>(["blocked-session"]);
    const api = createConsentEngine({
      store,
      wal,
      policyVersion,
      quarantine,
    });
    const token = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "blocked-session",
      contextHash: "h",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    expect(token).toBeNull();

    const store2 = createInMemoryTokenStore();
    const token2 = buildToken({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "blocked-session",
      contextHash: "h",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
    });
    store2.put(token2);
    const api2 = createConsentEngine({
      store: store2,
      wal: createInMemoryWal(),
      policyVersion,
      quarantine,
    });
    const consume = await api2.consume({
      jti: token2.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "blocked-session",
      contextHash: "h",
    });
    expect(consume.allowed).toBe(false);
    if (!consume.allowed) {
      expect(consume.reasonCode).toBe(CONSENT_REASON.CONTAINMENT_QUARANTINE);
    }
  });

  it("status without sessionKey returns tokens globally and supports tenant filter", async () => {
    const api = createEngine();
    const tokenA = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a",
      contextHash: "a",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
      tenantId: "tenant-a",
    });
    const tokenB = await api.issue({
      tool: "write",
      trustTier: "T0",
      sessionKey: "session-b",
      contextHash: "b",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
      tenantId: "tenant-b",
    });
    expect(tokenA).not.toBeNull();
    expect(tokenB).not.toBeNull();

    const all = await api.status({});
    expect(all.tokens.some((t) => t.jti === tokenA!.jti)).toBe(true);
    expect(all.tokens.some((t) => t.jti === tokenB!.jti)).toBe(true);

    const tenantA = await api.status({ tenantId: "tenant-a" });
    expect(tenantA.tokens.some((t) => t.jti === tokenA!.jti)).toBe(true);
    expect(tenantA.tokens.some((t) => t.jti === tokenB!.jti)).toBe(false);
  });

  it("revoke supports tenant-wide revocation", async () => {
    const api = createEngine();
    const tokenTenantA1 = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a1",
      contextHash: "a1",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
      tenantId: "tenant-a",
    });
    const tokenTenantA2 = await api.issue({
      tool: "write",
      trustTier: "T0",
      sessionKey: "session-a2",
      contextHash: "a2",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
      tenantId: "tenant-a",
    });
    const tokenTenantB = await api.issue({
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-b1",
      contextHash: "b1",
      ttlMs: 60_000,
      issuedBy: "op",
      policyVersion,
      tenantId: "tenant-b",
    });
    expect(tokenTenantA1).not.toBeNull();
    expect(tokenTenantA2).not.toBeNull();
    expect(tokenTenantB).not.toBeNull();

    const revoked = await api.revoke({ tenantId: "tenant-a" });
    expect(revoked.revoked).toBe(2);

    const consumeA1 = await api.consume({
      jti: tokenTenantA1!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-a1",
      contextHash: "a1",
      tenantId: "tenant-a",
    });
    expect(consumeA1.allowed).toBe(false);
    if (!consumeA1.allowed) {
      expect(consumeA1.reasonCode).toBe(CONSENT_REASON.TOKEN_REVOKED);
    }

    const consumeA2 = await api.consume({
      jti: tokenTenantA2!.jti,
      tool: "write",
      trustTier: "T0",
      sessionKey: "session-a2",
      contextHash: "a2",
      tenantId: "tenant-a",
    });
    expect(consumeA2.allowed).toBe(false);
    if (!consumeA2.allowed) {
      expect(consumeA2.reasonCode).toBe(CONSENT_REASON.TOKEN_REVOKED);
    }

    const consumeB = await api.consume({
      jti: tokenTenantB!.jti,
      tool: "exec",
      trustTier: "T0",
      sessionKey: "session-b1",
      contextHash: "b1",
      tenantId: "tenant-b",
    });
    expect(consumeB.allowed).toBe(true);
  });
});
