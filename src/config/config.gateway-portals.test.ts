import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

const ingress = { domain: "previews.example.net", port: 18890 };

describe("private portal ingress config", () => {
  it.each(["https://previews.example.net", "*.example.net", "127.0.0.1"])(
    "rejects unsafe domain %s",
    (domain) => {
      expect(
        GatewayConfigSchema.safeParse({ portals: { ingress: { ...ingress, domain } } }).success,
      ).toBe(false);
    },
  );

  it("rejects a port shared with the Gateway", () => {
    expect(
      GatewayConfigSchema.safeParse({ portals: { ingress: { ...ingress, port: 18789 } } }).success,
    ).toBe(false);
  });

  it.each(["https://previews.example.net", "https://CONTROL.PREVIEWS.EXAMPLE.NET:8443"])(
    "rejects Gateway and Control UI hostname collision %s",
    (origin) => {
      expect(
        GatewayConfigSchema.safeParse({ publicOrigin: origin, portals: { ingress } }).success,
      ).toBe(false);
      expect(
        GatewayConfigSchema.safeParse({
          controlUi: { allowedOrigins: [origin] },
          portals: { ingress },
        }).success,
      ).toBe(false);
    },
  );
});
