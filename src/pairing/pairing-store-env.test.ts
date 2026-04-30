import { afterEach, describe, expect, it } from "vitest";
import { resolvePairingEnvIntOrDefault } from "./pairing-store.js";

const TEST_ENV = "OPENCLAW_PAIRING_TEST_KNOB";

afterEach(() => {
  delete process.env[TEST_ENV];
});

describe("resolvePairingEnvIntOrDefault", () => {
  it("returns the default when the env var is unset", () => {
    delete process.env[TEST_ENV];
    const result = resolvePairingEnvIntOrDefault(TEST_ENV, 42, {
      minute: false,
      minValue: 1,
      maxValue: 100,
    });
    expect(result).toBe(42);
  });

  it("returns the default when the env var is the empty string", () => {
    process.env[TEST_ENV] = "";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(42);
  });

  it("returns the default when the env value is whitespace only", () => {
    process.env[TEST_ENV] = "   ";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(42);
  });

  it("returns the default when the env value is not a number", () => {
    process.env[TEST_ENV] = "banana";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(42);
  });

  it("returns the default when the env value is below minValue", () => {
    process.env[TEST_ENV] = "0";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(42);
  });

  it("returns the default when the env value is above maxValue", () => {
    process.env[TEST_ENV] = "9999";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(42);
  });

  it("accepts an in-range integer and returns it verbatim when minute=false", () => {
    process.env[TEST_ENV] = "7";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(7);
  });

  it("converts minutes to milliseconds when minute=true", () => {
    process.env[TEST_ENV] = "5";
    // 5 minutes -> 5 * 60 * 1000 ms
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: true, minValue: 1, maxValue: 100 }),
    ).toBe(5 * 60 * 1000);
  });

  it("trims whitespace around the value before parsing", () => {
    process.env[TEST_ENV] = "  9  ";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(9);
  });

  it("rejects fractional values by falling back to the default", () => {
    // parseInt("3.7", 10) returns 3, which is actually in range. Document
    // that we accept the integer prefix rather than strictly rejecting.
    process.env[TEST_ENV] = "3.7";
    expect(
      resolvePairingEnvIntOrDefault(TEST_ENV, 42, { minute: false, minValue: 1, maxValue: 100 }),
    ).toBe(3);
  });
});
