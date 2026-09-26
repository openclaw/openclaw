import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { markPluginHttpLegacyListener } from "../plugins/http-legacy-listener.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveRequestClientIp } from "./webhook-ingress.js";

function request(): IncomingMessage {
  return {
    headers: { "x-forwarded-for": "192.0.2.99" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("resolveRequestClientIp", () => {
  it.each([false, true])("uses the listener's proxy attribution policy (legacy=%s)", (legacy) => {
    const req = request();
    if (legacy) {
      markPluginHttpLegacyListener(req, { port: 8788 });
    }
    const clientIp = withPluginRuntimeGatewayRequestScope(
      {
        client: { clientIp: "198.51.100.42" } as never,
        isWebchatConnect: () => false,
      },
      () => resolveRequestClientIp(req, ["127.0.0.1"]),
    );

    expect(clientIp).toBe(legacy ? "192.0.2.99" : "198.51.100.42");
  });

  it("retains configured-proxy resolution outside Gateway request scope", () => {
    expect(resolveRequestClientIp(request(), ["127.0.0.1"])).toBe("192.0.2.99");
  });
});
