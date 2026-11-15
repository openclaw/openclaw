// Handshake timeout tests document env/config/default precedence and supported
// clamping for pre-auth and connect-challenge timeouts.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
  resolveConnectChallengeTimeoutMs,
  resolvePreauthHandshakeTimeoutMs,
} from "../../packages/gateway-client/src/timeouts.js";

describe("gateway handshake timeouts", () => {
  test("resolves preauth handshake timeout with env over config over default", () => {
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: "75000" },
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(75_000);
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: {},
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: "garbage" },
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(resolvePreauthHandshakeTimeoutMs({ env: {} })).toBe(
      DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
    );
  });

  test("resolveConnectChallengeTimeoutMs falls back to env override", () => {
    const original = process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
    const originalHandshake = process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
    try {
      process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = "5000";
      expect(resolveConnectChallengeTimeoutMs()).toBe(5_000);
      // Explicit value still takes precedence over env
      expect(resolveConnectChallengeTimeoutMs(3_000)).toBe(3_000);
      process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = "";
      process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = "30000";
      expect(resolveConnectChallengeTimeoutMs()).toBe(30_000);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = original;
      }
      if (originalHandshake === undefined) {
        delete process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = originalHandshake;
      }
    }
  });

  test("resolveConnectChallengeTimeoutMs follows configured preauth timeout", () => {
    expect(
      resolveConnectChallengeTimeoutMs(undefined, { env: {}, configuredTimeoutMs: 30_000 }),
    ).toBe(30_000);
    expect(resolveConnectChallengeTimeoutMs(45_000, { env: {}, configuredTimeoutMs: 30_000 })).toBe(
      30_000,
    );
    expect(resolveConnectChallengeTimeoutMs(0, { env: {}, configuredTimeoutMs: 30_000 })).toBe(
      MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
  });
});
