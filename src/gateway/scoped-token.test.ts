import { describe, expect, it } from "vitest";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  createScopedToken,
  generateSigningKey,
  isScopedToken,
  parseScopedToken,
  validateScopedToken,
} from "./scoped-token.js";

describe("scoped-token", () => {
  const signingKey = generateSigningKey();

  it("create → parse roundtrip preserves all fields", () => {
    const token = createScopedToken({
      signingKey,
      subject: "test-laptop",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      methods: ["send", "poll"],
      ttlSeconds: 3600,
    });

    const payload = parseScopedToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.v).toBe(1);
    expect(payload!.sub).toBe("test-laptop");
    expect(payload!.role).toBe("operator");
    expect(payload!.scopes).toEqual(["operator.read", "operator.write"]);
    expect(payload!.methods).toEqual(["send", "poll"]);
    expect(payload!.jti).toHaveLength(21);
    expect(typeof payload!.iat).toBe("number");
    expect(payload!.exp).toBe(payload!.iat + 3600);
  });

  it("validate with correct key returns valid: true", () => {
    const token = createScopedToken({
      signingKey,
      subject: "valid-test",
      role: "operator",
      scopes: ["operator.read"],
      ttlSeconds: 3600,
    });
    const result = validateScopedToken({ token, signingKey });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.sub).toBe("valid-test");
    }
  });

  it("validate with wrong key returns bad-signature", () => {
    const token = createScopedToken({
      signingKey,
      subject: "wrong-key-test",
      role: "operator",
      scopes: ["operator.read"],
      ttlSeconds: 3600,
    });
    const wrongKey = generateSigningKey();
    const result = validateScopedToken({ token, signingKey: wrongKey });
    expect(result).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("expired token returns expired", () => {
    const token = createScopedToken({
      signingKey,
      subject: "expired-test",
      role: "operator",
      scopes: ["operator.read"],
      ttlSeconds: 1,
    });
    // Validate with a time far in the future
    const futureTime = Math.floor(Date.now() / 1000) + 10_000;
    const result = validateScopedToken({ token, signingKey, now: futureTime });
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("not-yet-valid token (nbf in future) returns not-yet-valid", () => {
    const token = createScopedToken({
      signingKey,
      subject: "nbf-test",
      role: "operator",
      scopes: ["operator.read"],
      ttlSeconds: 3600,
    });
    // Manually inject nbf by re-encoding
    const payload = parseScopedToken(token)!;
    const futureNbf = payload.iat + 9999;

    // Create a token with nbf set by modifying the payload encoding
    const modifiedPayload = { ...payload, nbf: futureNbf };
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const payloadB64 = Buffer.from(JSON.stringify(modifiedPayload)).toString("base64url");
    const sig = createHmac("sha256", signingKey).update(payloadB64).digest().toString("base64url");
    const nbfToken = `osc_${payloadB64}.${sig}`;

    const result = validateScopedToken({ token: nbfToken, signingKey, now: payload.iat });
    expect(result).toEqual({ valid: false, reason: "not-yet-valid" });
  });

  it("malformed token (bad base64, missing fields) returns malformed", () => {
    expect(validateScopedToken({ token: "osc_not-valid-base64", signingKey })).toEqual({
      valid: false,
      reason: "malformed",
    });
    expect(validateScopedToken({ token: "osc_abc.def", signingKey })).toEqual({
      valid: false,
      reason: "bad-signature",
    });
    expect(validateScopedToken({ token: "not-a-scoped-token", signingKey })).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("isScopedToken correctly identifies osc_ prefix", () => {
    expect(isScopedToken("osc_abc.def")).toBe(true);
    expect(isScopedToken("osc_")).toBe(true);
    expect(isScopedToken("regular-token-string")).toBe(false);
    expect(isScopedToken("")).toBe(false);
  });

  it("scope enforcement: read-only token fails admin method", () => {
    const result = authorizeOperatorScopesForMethod("config.patch", ["operator.read"]);
    expect(result.allowed).toBe(false);
  });

  it("scope enforcement: read-only token passes read method", () => {
    const result = authorizeOperatorScopesForMethod("health", ["operator.read"]);
    expect(result.allowed).toBe(true);
  });

  it("token without TTL has no exp field", () => {
    const token = createScopedToken({
      signingKey,
      subject: "no-ttl",
      role: "operator",
      scopes: ["operator.read"],
    });
    const payload = parseScopedToken(token);
    expect(payload!.exp).toBeUndefined();
  });
});
