import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../server-methods/types.js";
import {
  bindGatewayClientAuthorizationDomain,
  getGatewayClientAuthorizationDomain,
  inheritGatewayClientAuthorizationDomain,
} from "./client-domain.js";

function client(): GatewayClient {
  return {
    connect: {
      role: "operator",
      scopes: ["operator.write"],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  };
}

describe("server-owned gateway client domain", () => {
  it("ignores plugin-visible object mutation", () => {
    const gatewayClient = client();
    bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" });

    (
      gatewayClient as GatewayClient & { authorizationDomain?: { id: string } }
    ).authorizationDomain = {
      id: "domain-2",
    };

    expect(getGatewayClientAuthorizationDomain(gatewayClient)).toEqual({ id: "domain-1" });
  });

  it("is idempotent for one domain and rejects rebinding", () => {
    const gatewayClient = client();
    bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" });
    expect(() =>
      bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-1" }),
    ).not.toThrow();
    expect(() => bindGatewayClientAuthorizationDomain(gatewayClient, { id: "domain-2" })).toThrow(
      /already bound differently/i,
    );
  });

  it("copies the private binding only through the core inheritance helper", () => {
    const source = client();
    const target = { ...source };
    bindGatewayClientAuthorizationDomain(source, { id: "domain-1" });

    expect(getGatewayClientAuthorizationDomain(target)).toBeUndefined();
    inheritGatewayClientAuthorizationDomain(source, target);
    expect(getGatewayClientAuthorizationDomain(target)).toEqual({ id: "domain-1" });
  });
});
