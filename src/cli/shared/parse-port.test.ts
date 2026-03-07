import { describe, expect, it } from "vitest";
import { parsePort } from "./parse-port.js";

describe("parsePort", () => {
  it.each([
    { raw: undefined, expected: null },
    { raw: null, expected: null },
    { raw: "", expected: null },
    { raw: " ", expected: null },
    { raw: "0", expected: null },
    { raw: "-1", expected: null },
    { raw: "1", expected: 1 },
    { raw: " 443 ", expected: 443 },
    { raw: 443, expected: 443 },
    { raw: "65535", expected: 65535 },
    { raw: "65536", expected: null },
    { raw: "22abc", expected: null },
    { raw: "22.2", expected: null },
    { raw: "abc22", expected: null },
  ])("parses %j", ({ raw, expected }) => {
    expect(parsePort(raw)).toBe(expected);
  });

  it("accepts bigint ports", () => {
    expect(parsePort(443n)).toBe(443);
  });
});
