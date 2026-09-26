import { describe, expect, it } from "vitest";
import {
  parseOptionalFiniteNumber,
  parseOptionalPositiveInteger,
  parseOptionalTimeoutMs,
} from "./shared.js";

describe("capability CLI numeric option parsing", () => {
  it("keeps omitted optional values absent and parses valid values", () => {
    expect(parseOptionalFiniteNumber(undefined, "--duration")).toBeUndefined();
    expect(parseOptionalFiniteNumber("2.5", "--duration")).toBe(2.5);

    expect(parseOptionalPositiveInteger(undefined, "--limit")).toBeUndefined();
    expect(parseOptionalPositiveInteger("3", "--limit")).toBe(3);

    expect(parseOptionalTimeoutMs(undefined)).toBeUndefined();
    expect(parseOptionalTimeoutMs("1200")).toBe(1200);
  });

  it.each([
    ["--duration", () => parseOptionalFiniteNumber("", "--duration")],
    ["--duration", () => parseOptionalFiniteNumber("  ", "--duration")],
    ["--limit", () => parseOptionalPositiveInteger("", "--limit")],
    ["--limit", () => parseOptionalPositiveInteger("  ", "--limit")],
  ])("rejects explicit blank %s values", (label, parse) => {
    expect(parse).toThrow(`${label} must be`);
  });

  it.each(["", "  ", "1000ms"])("rejects invalid --timeout-ms value %j", (raw) => {
    // A substring match would still pass on a message that names the wrong flag.
    expect(() => parseOptionalTimeoutMs(raw)).toThrow(
      "Invalid --timeout-ms. Use a positive millisecond value, e.g. --timeout-ms 30000.",
    );
  });
});
