import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, getHandshakeTimeoutMs } from "./server-constants.js";

const ORIGINAL_ENV = {
  VITEST: process.env.VITEST,
  OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS,
};

afterEach(() => {
  if (ORIGINAL_ENV.VITEST === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = ORIGINAL_ENV.VITEST;
  }

  if (ORIGINAL_ENV.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS === undefined) {
    delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
  } else {
    process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS =
      ORIGINAL_ENV.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
  }
});

describe("server handshake timeout", () => {
  it("defaults to the loopback-safe handshake timeout", () => {
    delete process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS;
    expect(getHandshakeTimeoutMs()).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(DEFAULT_HANDSHAKE_TIMEOUT_MS).toBe(10_000);
  });

  it("allows tests to override the handshake timeout budget", () => {
    process.env.VITEST = "1";
    process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS = "250";
    expect(getHandshakeTimeoutMs()).toBe(250);
  });
});
