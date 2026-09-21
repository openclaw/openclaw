import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayAuthPolicyGeneration } from "../auth-policy.js";
import { disconnectDisallowedGatewayPolicyClients } from "./ws-origin-policy.js";
import { holdGatewayPolicyResponse, registerGatewayPolicyResponse } from "./ws-policy-close.js";

describe("committed browser origin policy", () => {
  it.each(["allowedOrigins", "dangerouslyAllowHostHeaderOriginFallback"] as const)(
    "retires only clients no longer admitted after %s changes",
    (policy) => {
      const revoked = {
        browserOrigin: {
          origin: "https://revoked.example.test",
          requestHost: "revoked.example.test",
          isLocalClient: false,
        },
        invalidated: false,
        invalidatedReason: undefined as string | undefined,
        socket: { close: vi.fn() },
      };
      const retained = {
        browserOrigin: {
          origin: "https://retained.example.test",
          requestHost: "gateway.example.test",
          isLocalClient: false,
        },
        socket: { close: vi.fn() },
      };
      const backend = { socket: { close: vi.fn() } };
      const clients = [revoked, retained, backend];
      disconnectDisallowedGatewayPolicyClients(clients, {
        gateway: {
          controlUi: {
            allowedOrigins: [
              "https://retained.example.test",
              ...(policy === "allowedOrigins" ? ["https://revoked.example.test"] : []),
            ],
            dangerouslyAllowHostHeaderOriginFallback: policy !== "allowedOrigins",
          },
        },
      });
      expect(revoked.socket.close).not.toHaveBeenCalled();

      disconnectDisallowedGatewayPolicyClients(clients, {
        gateway: { controlUi: { allowedOrigins: ["https://retained.example.test"] } },
      });
      expect(revoked.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "origin not allowed");
      expect(revoked.invalidated).toBe(true);
      expect(revoked.invalidatedReason).toBe("origin-policy-changed");
      expect(retained.socket.close).not.toHaveBeenCalled();
      expect(backend.socket.close).not.toHaveBeenCalled();
    },
  );
});

describe("committed authentication policy", () => {
  it.each(["requiredHeaders", "allowUsers"] as const)(
    "keeps clients connected when trusted-proxy %s are reordered",
    (field) => {
      const trustedProxy = {
        userHeader: "x-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["reader@example.test", "writer@example.test"],
      };
      const client = {
        authPolicyGeneration: resolveGatewayAuthPolicyGeneration({
          gateway: { auth: { trustedProxy } },
        }),
        socket: { close: vi.fn() },
        invalidated: false,
      };
      disconnectDisallowedGatewayPolicyClients([client], {
        gateway: {
          auth: { trustedProxy: { ...trustedProxy, [field]: trustedProxy[field].toReversed() } },
        },
      });
      expect(client.socket.close).not.toHaveBeenCalled();
      expect(client.invalidated).toBe(false);
    },
  );

  it.each<OpenClawConfig["gateway"]>([
    { trustedProxies: ["192.0.2.10"] },
    { allowRealIpFallback: true },
    { auth: { allowTailscale: true } },
    { auth: { identityScopes: { "reader@example.test": ["operator.read"] } } },
    { auth: { trustedProxy: { userHeader: "x-user", allowUsers: ["reader@example.test"] } } },
    { auth: { trustedProxy: { userHeader: "x-user", deviceAutoApprove: { enabled: true } } } },
    {
      roles: {
        default: "reader",
        definitions: {
          reader: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
        },
      },
    },
  ])("revokes old authority and drains its accepted config response for %j", (gateway) => {
    const writer = {
      authPolicyGeneration: resolveGatewayAuthPolicyGeneration({}),
      socket: { close: vi.fn() },
      invalidated: false,
    };
    const respond = vi.fn();
    const response = registerGatewayPolicyResponse("config.patch", writer, respond);
    holdGatewayPolicyResponse(respond);
    const nextConfig = { gateway };
    const fresh = {
      authPolicyGeneration: resolveGatewayAuthPolicyGeneration(nextConfig),
      socket: { close: vi.fn() },
    };
    const worker = { socket: { close: vi.fn() } };

    disconnectDisallowedGatewayPolicyClients([writer, fresh, worker], nextConfig);

    expect(writer.invalidated).toBe(true);
    expect(writer.socket.close).not.toHaveBeenCalled();
    response?.finish();
    expect(writer.socket.close).toHaveBeenCalledExactlyOnceWith(4001, "gateway policy changed");
    expect(fresh.socket.close).not.toHaveBeenCalled();
    expect(worker.socket.close).not.toHaveBeenCalled();
  });
});
