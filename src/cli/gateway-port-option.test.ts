// Gateway port option tests cover strict CLI validation before transports open.
import { describe, expect, it } from "vitest";
import { parseGatewayPortOption } from "./gateway-port-option.js";

describe("parseGatewayPortOption", () => {
  it("accepts TCP port values", () => {
    expect(parseGatewayPortOption("18789")).toBe(18789);
    expect(parseGatewayPortOption(65_535)).toBe(65_535);
  });

  it("treats an absent value as no override", () => {
    expect(parseGatewayPortOption(undefined)).toBeUndefined();
  });

  it.each(["", "0", "65536", "1e4", "18789ms"])("rejects invalid port value %j", (value) => {
    expect(() => parseGatewayPortOption(value)).toThrow(
      "--port must be an integer between 1 and 65535.",
    );
  });
});
