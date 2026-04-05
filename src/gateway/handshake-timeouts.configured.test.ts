import { describe, expect, it } from "vitest";
import {
  MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
  getPreauthHandshakeTimeoutMsFromEnv,
} from "./handshake-timeouts.js";

describe("getPreauthHandshakeTimeoutMsFromEnv", () => {
  it("falls back to configured gateway timeout when env overrides are absent", () => {
    expect(getPreauthHandshakeTimeoutMsFromEnv({}, 45_000)).toBe(45_000);
  });

  it("prefers env overrides over the configured gateway timeout", () => {
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({ OPENCLAW_HANDSHAKE_TIMEOUT_MS: "75" }, 45_000),
    ).toBe(75);
  });

  it("clamps configured gateway timeout into the safe range", () => {
    expect(getPreauthHandshakeTimeoutMsFromEnv({}, 999_999_999)).toBe(
      MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
  });
});
