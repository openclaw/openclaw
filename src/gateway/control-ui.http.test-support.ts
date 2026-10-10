import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import { vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { makeMockHttpResponse } from "./test-http-response.js";

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

export type RequestParams = {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  headers?: IncomingMessage["headers"];
  distinctHeaders?: IncomingMessage["headersDistinct"];
  remoteAddress?: string;
};
function makeRequest(params: RequestParams): IncomingMessage {
  const headers = params.headers ?? {};
  // SAFETY: HTTP handler fixtures supply the request fields used by the tested routes.
  return {
    url: params.url,
    method: params.method ?? "GET",
    headers,
    headersDistinct:
      params.distinctHeaders ??
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value : [String(value)],
        ]),
      ),
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
  } as IncomingMessage;
}

export async function runRequest<Options>(
  handler: (req: IncomingMessage, res: ServerResponse, options: Options) => Promise<boolean>,
  params: RequestParams,
  options: Options,
) {
  const response = makeMockHttpResponse();
  const handled = await handler(makeRequest(params), response.res, options);
  return { ...response, handled };
}
