import type { IncomingMessage } from "node:http";
import os from "node:os";
import { vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import type { ResolvedGatewayAuth } from "./auth.js";

export function setupTrustedProxyAuth(): ResolvedGatewayAuth {
  vi.spyOn(os, "networkInterfaces").mockReturnValue(
    makeNetworkInterfacesSnapshot({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "10.0.0.2", family: "IPv4" }],
    }),
  );
  return {
    mode: "trusted-proxy",
    allowTailscale: false,
    trustedProxy: {
      userHeader: "x-forwarded-user",
    },
  };
}

export function createTrustedProxyHeaders(
  extraHeaders: IncomingMessage["headers"] = {},
): IncomingMessage["headers"] {
  return {
    host: "gateway.example.com",
    "x-forwarded-user": "nick@example.com",
    "x-forwarded-for": "203.0.113.10",
    "x-forwarded-proto": "https",
    ...extraHeaders,
  };
}
