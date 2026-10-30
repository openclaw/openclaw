/**
 * WebSocket handshake auth log limiter tests.
 */
import { describe, expect, it } from "vitest";
import { HandshakeAuthLogLimiter } from "./handshake-auth-log-limiter.js";

describe("HandshakeAuthLogLimiter", () => {
  it("suppresses repeated selected failures for the same client key within the interval", () => {
    const limiter = new HandshakeAuthLogLimiter();
    const client = {
      reason: "token_missing",
      remoteAddr: "127.0.0.1",
      client: "gateway:sessions.list",
      mode: "backend",
      authProvided: "none",
    };

    expect(limiter.missingCredentialLogSuffix(client, 10_000)).toBe("");
    expect(limiter.missingCredentialLogSuffix(client, 10_100)).toBeUndefined();
    expect(limiter.missingCredentialLogSuffix(client, 10_200)).toBeUndefined();
    expect(limiter.missingCredentialLogSuffix(client, 40_001)).toBe(" suppressed=2");
  });

  it("does not suppress distinct clients", () => {
    const limiter = new HandshakeAuthLogLimiter();

    for (const client of ["gateway:sessions.list", "gateway:health"]) {
      expect(
        limiter.missingCredentialLogSuffix(
          { reason: "token_missing", remoteAddr: "127.0.0.1", client, authProvided: "none" },
          10,
        ),
      ).toBe("");
    }
  });

  it("evicts the oldest client after reaching its entry limit", () => {
    const limiter = new HandshakeAuthLogLimiter();
    const first = { reason: "token_missing", authProvided: "none", client: "first" };

    expect(limiter.missingCredentialLogSuffix(first, 0)).toBe("");
    expect(limiter.missingCredentialLogSuffix(first, 1_000)).toBeUndefined();

    for (let i = 0; i < 256; i += 1) {
      limiter.missingCredentialLogSuffix({ ...first, client: `key-${i}` }, i);
    }

    expect(limiter.missingCredentialLogSuffix(first, 2_000)).toBe("");
  });

  it("only rate-limits benign missing-credential startup retries", () => {
    const limiter = new HandshakeAuthLogLimiter();
    for (const reason of ["token_missing", "password_missing"]) {
      const client = { reason, authProvided: "none" };
      expect(limiter.missingCredentialLogSuffix(client, 0)).toBe("");
      expect(limiter.missingCredentialLogSuffix(client, 1)).toBeUndefined();
    }

    for (const reason of [
      "token_mismatch",
      "password_mismatch",
      "device_token_mismatch",
      "rate_limited",
      "token_missing_config",
    ]) {
      const client = { reason, authProvided: "none" };
      expect(limiter.missingCredentialLogSuffix(client, 0)).toBe("");
      expect(limiter.missingCredentialLogSuffix(client, 1)).toBe("");
    }
    const credentialProvided = { reason: "token_missing", authProvided: "token" };
    expect(limiter.missingCredentialLogSuffix(credentialProvided, 0)).toBe("");
    expect(limiter.missingCredentialLogSuffix(credentialProvided, 1)).toBe("");
  });
});
