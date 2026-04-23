import { describe, expect, it } from "vitest";
import {
  buildGatewayHttpHeaders,
  resolveGatewayHttpAuthHeader,
  resolveGatewayHttpAuthHeaders,
} from "../gateway-http-auth.js";

describe("resolveGatewayHttpAuthHeader", () => {
  it("prefers the configured gateway token over the paired device token for HTTP requests", () => {
    expect(
      resolveGatewayHttpAuthHeader({
        settings: { token: "gateway-token" },
        hello: { auth: { deviceToken: "paired-device-token" } },
      }),
    ).toBe("Bearer gateway-token");
  });

  it("falls back to the gateway password when no token is configured", () => {
    expect(
      resolveGatewayHttpAuthHeader({
        password: "gateway-password",
        hello: { auth: { deviceToken: "paired-device-token" } },
      }),
    ).toBe("Bearer gateway-password");
  });

  it("uses the device token only when no gateway token or password is available", () => {
    expect(
      resolveGatewayHttpAuthHeader({
        hello: { auth: { deviceToken: "paired-device-token" } },
      }),
    ).toBe("Bearer paired-device-token");
  });

  it("trims whitespace and omits auth headers when nothing usable is present", () => {
    expect(
      resolveGatewayHttpAuthHeader({
        settings: { token: "   " },
        password: " ",
        hello: { auth: { deviceToken: "   " } },
      }),
    ).toBeNull();
  });
});

describe("resolveGatewayHttpAuthHeaders", () => {
  it("returns all usable credentials in fallback order without duplicates", () => {
    expect(
      resolveGatewayHttpAuthHeaders({
        settings: { token: " gateway-token " },
        password: "gateway-password",
        hello: { auth: { deviceToken: "gateway-password" } },
      }),
    ).toEqual(["Bearer gateway-token", "Bearer gateway-password"]);
  });

  it("returns an empty list when no credentials are available", () => {
    expect(
      resolveGatewayHttpAuthHeaders({
        settings: { token: "   " },
        password: " ",
        hello: { auth: { deviceToken: "   " } },
      }),
    ).toEqual([]);
  });
});

describe("buildGatewayHttpHeaders", () => {
  it("includes the resolved authorization header alongside extra headers", () => {
    expect(
      buildGatewayHttpHeaders(
        {
          settings: { token: "gateway-token" },
          hello: { auth: { deviceToken: "paired-device-token" } },
        },
        { "X-Test": "1" },
      ),
    ).toEqual({
      "X-Test": "1",
      Authorization: "Bearer gateway-token",
    });
  });
});
