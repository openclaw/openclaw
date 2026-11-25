import { request as httpRequest, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAcceptedBrowserOrigin } from "../../plugin-sdk/webhook-request-guards.js";
import type { PluginHttpRouteRegistration } from "../../plugins/registry.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { pickPrimaryLanIPv4 } from "../net.js";
import { createGatewayHttpServer } from "../server-http.js";
import { createGatewayTestRegistry } from "./__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

describe("plugin HTTP origin policy", () => {
  it("bounds mapped HTTP origins by serving policy and caller config", async () => {
    const cfg: OpenClawConfig = { gateway: { publicOrigin: "https://old.example.test" } };
    let pluginConfig: OpenClawConfig | undefined = cfg;
    let retainedRequest: IncomingMessage | undefined;
    let useRetainedRequest = false;
    const route: PluginHttpRouteRegistration = {
      pluginId: "origin-proof",
      source: "origin-proof",
      path: "/origin-proof",
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        await Promise.resolve();
        retainedRequest ??= req;
        res.end(
          resolveAcceptedBrowserOrigin({
            req: useRetainedRequest ? retainedRequest : req,
            cfg: pluginConfig,
          }) ?? "denied",
        );
        return true;
      },
    };
    const host = pickPrimaryLanIPv4();
    if (!host) {
      throw new Error("Origin dispatch proof requires a non-loopback local interface");
    }
    const listener = await reserveTestPortListener({
      host,
      offsets: [0],
      createListener: () =>
        createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "",
          resolvedAuth: { mode: "none", allowTailscale: false },
          getRuntimeConfig: () => cfg,
          publishedPort: 25432,
          handleHooksRequest: async () => false,
          shouldEnforcePluginGatewayAuth: () => false,
          handlePluginRequest: createGatewayPluginRequestHandler({
            registry: createGatewayTestRegistry({ httpRoutes: [route] }),
            log: createSubsystemLogger("test/plugin-origin"),
          }),
        }),
    });
    const request = (origin: string) =>
      new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          {
            host,
            port: listener.claim.port,
            path: route.path,
            headers: { origin, host: "gateway.example.test:18789" },
            agent: false,
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve(body));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      const mappedOrigin = "http://localhost:25432";
      expect(await request(mappedOrigin)).toBe(mappedOrigin);
      useRetainedRequest = true;
      expect(await request(mappedOrigin)).toBe("denied");
      useRetainedRequest = false;
      cfg.gateway!.publicOrigin = "https://new.example.test";
      expect(await request("https://old.example.test")).toBe("denied");
      expect(await request("https://new.example.test")).toBe("https://new.example.test");
      expect(await request(mappedOrigin)).toBe(mappedOrigin);
      cfg.gateway!.controlUi = { allowedOrigins: [] };
      expect(await request(mappedOrigin)).toBe("denied");
      pluginConfig = {};
      expect(await request(mappedOrigin)).toBe("denied");
      pluginConfig = undefined;
      expect(await request(mappedOrigin)).toBe("denied");
    } finally {
      await listener.releaseListener();
      await listener.claim.release();
    }
  });
});
