import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

const ingress = { domain: "previews.example.net", port: 18890 };

describe("private portal ingress config", () => {
  it("accepts the dedicated private wildcard contract without additional options", () => {
    expect(
      GatewayConfigSchema.safeParse({
        publicOrigin: "https://control.example.net",
        portals: { ingress },
      }).success,
    ).toBe(true);
    expect(
      GatewayConfigSchema.safeParse({ portals: { ingress: { ...ingress, public: true } } }).success,
    ).toBe(false);
  });

  it.each([
    "https://previews.example.net",
    "*.example.net",
    "localhost",
    "127.0.0.1",
    "example.net:443",
    "example.net/path",
    "example.net.",
    "-bad.example.net",
    `${"a".repeat(64)}.example.net`,
  ])("rejects unsafe domain %s", (domain) => {
    expect(
      GatewayConfigSchema.safeParse({ portals: { ingress: { ...ingress, domain } } }).success,
    ).toBe(false);
  });

  it.each([0, -1, 65536, 1.5, 18789])("rejects invalid or conflicting port %s", (port) => {
    expect(
      GatewayConfigSchema.safeParse({ portals: { ingress: { ...ingress, port } } }).success,
    ).toBe(false);
  });

  it.each([
    "https://previews.example.net",
    "https://control.previews.example.net",
    "https://CONTROL.PREVIEWS.EXAMPLE.NET:8443",
  ])("rejects Gateway and Control UI hostname collision %s", (origin) => {
    expect(
      GatewayConfigSchema.safeParse({ publicOrigin: origin, portals: { ingress } }).success,
    ).toBe(false);
    expect(
      GatewayConfigSchema.safeParse({
        controlUi: { allowedOrigins: [origin] },
        portals: { ingress },
      }).success,
    ).toBe(false);
  });
});
