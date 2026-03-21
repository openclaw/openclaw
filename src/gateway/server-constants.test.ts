import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, getHandshakeTimeoutMs } from "./server-constants.js";

describe("getHandshakeTimeoutMs", () => {
  const savedEnv: Record<string, string | undefined> = {};

  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns default (15 s) when no env var is set", () => {
    setEnv("OPENCLAW_HANDSHAKE_TIMEOUT_MS", undefined);
    setEnv("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", undefined);
    expect(getHandshakeTimeoutMs()).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(DEFAULT_HANDSHAKE_TIMEOUT_MS).toBe(15_000);
  });

  it("respects OPENCLAW_HANDSHAKE_TIMEOUT_MS env var", () => {
    // Under Vitest, VITEST is set so this tests the fallback path
    // (OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS unset -> falls through to OPENCLAW_HANDSHAKE_TIMEOUT_MS).
    setEnv("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", undefined);
    setEnv("OPENCLAW_HANDSHAKE_TIMEOUT_MS", "20000");
    expect(getHandshakeTimeoutMs()).toBe(20_000);
  });

  it("ignores invalid string values", () => {
    setEnv("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", undefined);
    setEnv("OPENCLAW_HANDSHAKE_TIMEOUT_MS", "not-a-number");
    expect(getHandshakeTimeoutMs()).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
  });

  it("ignores zero or negative values", () => {
    setEnv("OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS", undefined);
    setEnv("OPENCLAW_HANDSHAKE_TIMEOUT_MS", "0");
    expect(getHandshakeTimeoutMs()).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);

    setEnv("OPENCLAW_HANDSHAKE_TIMEOUT_MS", "-5000");
    expect(getHandshakeTimeoutMs()).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
  });
});
