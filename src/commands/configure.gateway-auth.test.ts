import { describe, expect, it } from "vitest";
import { buildGatewayAuthConfig } from "./configure.gateway-auth.js";

describe("buildGatewayAuthConfig", () => {
  it.each([undefined, "undefined"])(
    "generates a token for missing or invalid input %j",
    (token) => {
      expect(buildGatewayAuthConfig({ mode: "token", token })).toEqual({
        mode: "token",
        token: expect.stringMatching(/^[a-f0-9]{48}$/),
      });
    },
  );

  it("rejects trusted-proxy mode without proxy configuration", () => {
    expect(() => buildGatewayAuthConfig({ mode: "trusted-proxy" })).toThrow(
      "trustedProxy config is required when mode is trusted-proxy",
    );
  });
});
