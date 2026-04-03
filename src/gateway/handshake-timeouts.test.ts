import { describe, expect, test } from "vitest";
import {
  clampConnectChallengeTimeoutMs,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  getConnectChallengeTimeoutMsFromEnv,
  getPreauthHandshakeTimeoutMsFromEnv,
  MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
  MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
  resolveConnectChallengeTimeoutMs,
} from "./handshake-timeouts.js";

describe("gateway handshake timeouts", () => {
  test("defaults connect challenge timeout to the shared pre-auth handshake timeout", () => {
    expect(resolveConnectChallengeTimeoutMs()).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  });

  test("clamps connect challenge timeouts into the supported range", () => {
    expect(clampConnectChallengeTimeoutMs(0)).toBe(MIN_CONNECT_CHALLENGE_TIMEOUT_MS);
    expect(clampConnectChallengeTimeoutMs(2_000)).toBe(2_000);
    expect(clampConnectChallengeTimeoutMs(20_000)).toBe(MAX_CONNECT_CHALLENGE_TIMEOUT_MS);
  });

  test("prefers OPENCLAW_HANDSHAKE_TIMEOUT_MS and falls back on the test-only env", () => {
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "75",
        OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "20",
      }),
    ).toBe(75);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "",
        OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "20",
        VITEST: "1",
      }),
    ).toBe(20);
  });

  test("getConnectChallengeTimeoutMsFromEnv reads OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS", () => {
    expect(getConnectChallengeTimeoutMsFromEnv({})).toBeUndefined();
    expect(
      getConnectChallengeTimeoutMsFromEnv({ OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "15000" }),
    ).toBe(15_000);
    expect(
      getConnectChallengeTimeoutMsFromEnv({ OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "garbage" }),
    ).toBeUndefined();
  });

  test("resolveConnectChallengeTimeoutMs falls back to env override", () => {
    const original = process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
    try {
      process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = "5000";
      expect(resolveConnectChallengeTimeoutMs()).toBe(5_000);
      // Explicit value still takes precedence over env
      expect(resolveConnectChallengeTimeoutMs(3_000)).toBe(3_000);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = original;
      }
    }
  });
});
