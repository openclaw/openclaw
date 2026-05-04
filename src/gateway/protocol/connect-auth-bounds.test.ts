import { describe, expect, test } from "vitest";
import { validateConnectParams } from "./index.js";
import {
  HANDSHAKE_AUTH_PASSWORD_MAX_LENGTH,
  HANDSHAKE_AUTH_TOKEN_MAX_LENGTH,
} from "./schema/primitives.js";

const baseConnectParams = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: "test",
    version: "1.0.0",
    platform: "test",
    mode: "test",
  },
  caps: [],
  commands: [],
  role: "operator",
  scopes: ["operator.read"],
};

describe("connect frame auth field bounds", () => {
  test("accepts auth fields at the documented maximum lengths", () => {
    const tokenAtCap = "a".repeat(HANDSHAKE_AUTH_TOKEN_MAX_LENGTH);
    const passwordAtCap = "p".repeat(HANDSHAKE_AUTH_PASSWORD_MAX_LENGTH);
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: {
        token: tokenAtCap,
        bootstrapToken: tokenAtCap,
        deviceToken: tokenAtCap,
        password: passwordAtCap,
      },
    });
    expect(ok).toBe(true);
  });

  test("rejects oversized auth.token before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { token: "a".repeat(HANDSHAKE_AUTH_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.bootstrapToken before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { bootstrapToken: "a".repeat(HANDSHAKE_AUTH_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.deviceToken before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { deviceToken: "a".repeat(HANDSHAKE_AUTH_TOKEN_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects oversized auth.password before any handshake work runs", () => {
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { password: "a".repeat(HANDSHAKE_AUTH_PASSWORD_MAX_LENGTH + 1) },
    });
    expect(ok).toBe(false);
  });

  test("rejects a 60KB bootstrap token (representative attacker payload)", () => {
    // The connect frame is capped at 64KB total (MAX_PREAUTH_PAYLOAD_BYTES)
    // so an attacker could fit a ~60KB bootstrap token in the schema-pre-cap
    // world. Confirm the cap rejects it long before safeEqualSecret pads
    // every stored bootstrap token comparison up to 60KB.
    const ok = validateConnectParams({
      ...baseConnectParams,
      auth: { bootstrapToken: "x".repeat(60_000) },
    });
    expect(ok).toBe(false);
  });
});
