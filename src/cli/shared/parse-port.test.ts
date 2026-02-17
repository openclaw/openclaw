import { describe, expect, it } from "vitest";
import { parsePort } from "./parse-port";

describe("parsePort", () => {
  it("accepts valid numeric ports", () => {
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort(" 443 ")).toBe(443);
    expect(parsePort(8080)).toBe(8080);
    expect(parsePort(65535n)).toBe(65535);
  });

  it("rejects invalid or out-of-range ports", () => {
    expect(parsePort(undefined)).toBeNull();
    expect(parsePort(null)).toBeNull();
    expect(parsePort(0)).toBeNull();
    expect(parsePort(-1)).toBeNull();
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort(65536)).toBeNull();
    expect(parsePort("99999999999999999999")).toBeNull();
  });

  it("rejects non-integer and mixed-format inputs", () => {
    expect(parsePort("3000abc")).toBeNull();
    expect(parsePort("12.5")).toBeNull();
    expect(parsePort(12.5)).toBeNull();
    expect(parsePort("1e3")).toBeNull();
    expect(parsePort("+80")).toBeNull();
    expect(parsePort(" ")).toBeNull();
    expect(parsePort("NaN")).toBeNull();
    expect(parsePort(Number.NaN)).toBeNull();
    expect(parsePort(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
