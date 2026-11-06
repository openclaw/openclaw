import { describe, expect, it } from "vitest";
import { parseGatewayClientPortOption, parseGatewayPortOption } from "./gateway-port-option.js";

describe("Gateway port options", () => {
  it.each([
    ["1", 1],
    ["18789", 18_789],
    [" \t18789 ", 18_789],
    [1e4, 10_000],
    [65_535, 65_535],
    [18_789n, 18_789],
  ])("accepts TCP port value %s", (value, expected) => {
    expect(parseGatewayPortOption(value)).toBe(expected);
  });

  it.each([undefined, null])("treats absent value %s as no override", (value) => {
    expect(parseGatewayPortOption(value)).toBeUndefined();
  });

  it.each(["", " \t ", "0", "65536", "1e4", "18789ms", 1.5, 65_536n])(
    "rejects invalid port value %s",
    (value) => {
      expect(() => parseGatewayClientPortOption(value)).toThrow(
        expect.objectContaining({ humanOutput: "--port must be an integer between 1 and 65535." }),
      );
    },
  );
});
