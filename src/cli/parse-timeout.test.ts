// Parse timeout tests cover CLI timeout argument parsing and validation.
import { describe, expect, it } from "vitest";
import { ExpectedCliError } from "./expected-cli-error.js";
import { parseTimeoutMs, parseTimeoutMsWithFallback } from "./parse-timeout.js";

describe("parseTimeoutMs", () => {
  it.each([undefined, "", "nope", "10abc", "1.5", "0x10", "0"])("rejects %j", (raw) => {
    expect(parseTimeoutMs(raw)).toBeUndefined();
  });
});

describe("parseTimeoutMsWithFallback", () => {
  it.each([undefined, null, "  "])("uses the fallback for missing value %j", (raw) => {
    expect(parseTimeoutMsWithFallback(raw, 3000)).toBe(3000);
  });

  it.each([2500, 2500n, "2500", "+2500"])("parses positive value %s", (raw) => {
    expect(parseTimeoutMsWithFallback(raw, 3000)).toBe(2500);
  });

  it("throws on unsupported types when requested", () => {
    const parse = () => parseTimeoutMsWithFallback({}, 3000, { invalidType: "error" });
    expect(parse).toThrow(ExpectedCliError);
    expect(parse).toThrow("Invalid --timeout");
  });

  it("throws on non-positive parsed values", () => {
    expect(() => parseTimeoutMsWithFallback("0", 3000, { flagName: "--timeout-ms" })).toThrow(
      'Invalid --timeout-ms. Use a positive millisecond value, e.g. --timeout-ms 30000. Received: "0".',
    );
    expect(() => parseTimeoutMsWithFallback("-1", 3000)).toThrow('Received: "-1"');
  });
});
