import { describe, expect, test } from "vitest";
import {
  clampConnectChallengeTimeoutMs,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
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

  test("ignores invalid handshake timeout overrides and falls back safely", () => {
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "abc",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "-1",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "0",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "   ",
        OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "20",
        VITEST: "1",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  });
});
