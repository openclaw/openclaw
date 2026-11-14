import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const parse = (openclawId: unknown) => OpenClawSchema.safeParse({ gateway: { openclawId } });

describe("gateway.openclawId", () => {
  it("round-trips the Labs switch and service endpoints", () => {
    const openclawId = {
      enabled: true,
      issuerUrl: "https://issuer.example.test/api/auth",
      clientId: "control-ui-client",
      discoveryUrl: "https://discovery.example.test",
      relayUrl: "https://relay.example.test/",
      loaderDomain: "loader.example.test",
    };
    const parsed = parse(openclawId);
    expect(parsed.success && parsed.data.gateway?.openclawId).toStrictEqual(openclawId);
  });

  it("allows plain HTTP only for loopback testbeds", () => {
    expect(parse({ relayUrl: "http://127.0.0.1:47351/" }).success).toBe(true);
    expect(parse({ relayUrl: "http://relay.example.test/" }).success).toBe(false);
  });

  it("rejects unknown keys and non-domain loader values", () => {
    expect(parse({ enabled: true, endpointId: "x" }).success).toBe(false);
    expect(parse({ loaderDomain: "https://loader.example.test" }).success).toBe(false);
  });
});
