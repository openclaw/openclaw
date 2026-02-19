import { describe, expect, it } from "vitest";
import { createConsentEngine } from "./engine.js";
import { buildToken, createInMemoryTokenStore } from "./store.js";
import { createInMemoryWal } from "./wal.js";
import { CONSENT_REASON } from "./reason-codes.js";

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
    expect(consume2.reasonCode).toBe(CONSENT_REASON.TOKEN_ALREADY_CONSUMED);
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
    expect(result.reasonCode).toBe(CONSENT_REASON.TOKEN_NOT_FOUND);
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
    expect(result.reasonCode).toBe(CONSENT_REASON.CONTEXT_MISMATCH);
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
    expect(consume.reasonCode).toBe(CONSENT_REASON.TOKEN_REVOKED);
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
    expect(consume.reasonCode).toBe(CONSENT_REASON.CONTAINMENT_QUARANTINE);
  });
});
