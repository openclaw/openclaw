// Gateway run inherited-PID parser tests cover strict positive-integer parsing.
import { describe, expect, it } from "vitest";
import { __testing } from "./run.js";

const { parseInheritedGatewayServicePid } = __testing;

describe("parseInheritedGatewayServicePid", () => {
  it("returns a positive integer for a clean numeric value", () => {
    expect(parseInheritedGatewayServicePid("12345")).toBe(12345);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseInheritedGatewayServicePid("  12345  ")).toBe(12345);
  });

  it("returns undefined for undefined / empty / whitespace-only input", () => {
    expect(parseInheritedGatewayServicePid(undefined)).toBeUndefined();
    expect(parseInheritedGatewayServicePid("")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("   ")).toBeUndefined();
  });

  it("rejects partial numeric values that Number.parseInt would have salvaged", () => {
    // ClawSweeper #90946 review P2: Number.parseInt("123abc", 10) === 123, so a
    // malformed inherited env value would protect PID 123 from cleanup and
    // leave the stale listener alive. Strict regex parsing closes that gap.
    expect(parseInheritedGatewayServicePid("123abc")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("123.4")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("0x7b")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("123 456")).toBeUndefined();
  });

  it("rejects negative and zero values", () => {
    expect(parseInheritedGatewayServicePid("-1")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("0")).toBeUndefined();
  });

  it("rejects non-numeric input", () => {
    expect(parseInheritedGatewayServicePid("abc")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("undefined")).toBeUndefined();
    expect(parseInheritedGatewayServicePid("NaN")).toBeUndefined();
  });
});
