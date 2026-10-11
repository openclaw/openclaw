import { ServerResponse, type IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  applyControlUiSecurityHeaders,
  validateRemoteControlUiFrameAncestors,
} from "./control-ui-csp.js";
import { serveControlUiIndexHtml } from "./control-ui-index.js";
import { sendControlUiHtmlBody } from "./control-ui-static.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { createSandboxHostHttpRequestHandler } from "./mcp-app-sandbox-http.js";
import { getRemoteControlUiIngressContext } from "./remote-control-ui-context.js";
import { resolveRemoteControlUiHttpRoute } from "./remote-control-ui-http-routing.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import { AUTH_TOKEN, createRequest, createResponse } from "./server-http.test-harness.js";

function remoteRequest(
  path: string,
  options: { method?: string; current?: () => void; remote?: boolean } = {},
) {
  const req = createRequest({ path, method: options.method ?? "GET", host: "ui.example.test" });
  if (options.remote !== false) {
    const context = createRemoteControlUiIngressTestContext({
      frameAncestors: ["https://chat.example.test", "codex-sandbox:"],
      assertCurrent: options.current ?? (() => {}),
    });
    markGatewayIngressTransport(req, { kind: "remote-forwarded", context });
  }
  return req;
}

describe("remote Control UI HTTP owner", () => {
  it("refuses private route families before hooks and plugin handlers can claim them", async () => {
    const hook = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.end("hook");
      return true;
    });
    const plugin = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.end("plugin");
      return true;
    });
    const handler = createGatewayHttpRequestHandler({
      clients: new Set(),
      controlUiBasePath: "/claw",
      controlUiEnabled: true,
      resolvedAuth: AUTH_TOKEN,
      getRuntimeConfig: () => ({}),
      handleHooksRequest: hook,
      handlePluginRequest: plugin,
    });
    try {
      for (const path of [
        "/hooks/wake",
        "/tools/invoke",
        "/v1/models",
        "/claw/api/unknown",
        "/claw/.well-known/openclaw/browser-bootstrap",
        "/readyz",
        "/healthz/private",
        "/browser/extension",
        "/claw/sw.js",
        "/mcp-app",
        "/__openclaw__/worker/ws",
      ]) {
        const req = remoteRequest(path);
        const response = createResponse(req);
        await handler(req, response.res);
        expect(response.res.statusCode, path).toBe(404);
      }
      expect(hook).not.toHaveBeenCalled();
      expect(plugin).not.toHaveBeenCalled();
      const req = remoteRequest("/hooks/wake", { remote: false });
      const response = createResponse(req);
      await handler(req, response.res);
      expect(response.getBody()).toBe("hook");
    } finally {
      handler.dispose();
    }
  });

  it("allows only declared panel route ownership and keeps the native resource families", () => {
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push(
      {
        pluginId: "panel",
        source: "fixture",
        path: "/reports",
        match: "prefix",
        auth: "gateway",
        handler: () => true,
      },
      {
        pluginId: "webhook",
        source: "fixture",
        path: "/webhook",
        match: "prefix",
        auth: "plugin",
        handler: () => true,
      },
      {
        pluginId: "webhook",
        source: "fixture",
        path: "/claw/settings/plugins",
        match: "exact",
        auth: "plugin",
        handler: () => true,
      },
    );
    registry.controlUiDescriptors.push({
      pluginId: "panel",
      pluginName: "Panel",
      source: "fixture",
      descriptor: {
        id: "panel",
        label: "Panel",
        surface: "tab",
        path: "/reports/",
        requiredScopes: ["operator.read"],
      },
    });
    withPluginRuntimeRegistryScope(registry, () => {
      expect(
        resolveRemoteControlUiHttpRoute(remoteRequest("/reports/asset.js"), "/claw", [
          "operator.read",
        ]),
      ).toBe("plugin-panel");
      expect(
        resolveRemoteControlUiHttpRoute(remoteRequest("/webhook/event"), "/claw", [
          "operator.read",
        ]),
      ).toBeUndefined();
      expect(
        resolveRemoteControlUiHttpRoute(remoteRequest("/claw/settings/plugins"), "/claw", [
          "operator.read",
        ]),
      ).toBe("document");
      for (const [path, owner] of [
        ["/claw/", "document"],
        ["/claw/assets/app.js", "document"],
        ["/claw/control-ui-config.json", "document"],
        ["/claw/avatar/main", "resource"],
        ["/api/users/person/avatar", "resource"],
        ["/claw/__openclaw__/plugin-icon/plugin", "resource"],
        ["/claw/__openclaw__/channel-avatar/agent%3Amain%3Adashboard%3Afoo%2Fbar", "resource"],
        ["/claw/__openclaw__/assistant-media?source=file", "assistant-media"],
        ["/api/chat/media/outgoing/file", "outgoing-media"],
        ["/api/artifacts/download/connection/ticket", "artifact"],
        ["/__openclaw__/board/session/widget/index.html", "board"],
        ["/claw/__openclaw__/plugins/control-ui/plugin/revision/app.js", "native-assets"],
      ]) {
        expect(
          resolveRemoteControlUiHttpRoute(remoteRequest(path!), "/claw", ["operator.read"]),
          path,
        ).toBe(owner);
      }
    });
  });

  it("applies the approved ancestor chain only to the remote document", async () => {
    for (const remote of [false, true]) {
      const req = remoteRequest("/claw/", { remote });
      const res = new ServerResponse(req);
      applyControlUiSecurityHeaders(res, getRemoteControlUiIngressContext(req));
      await serveControlUiIndexHtml(
        req,
        res,
        "<html><head></head><body>synthetic</body></html>",
        "/",
        "/claw",
      );
      expect(res.getHeader("Content-Security-Policy")).toContain(
        remote
          ? "frame-ancestors https://chat.example.test codex-sandbox:"
          : "frame-ancestors 'none'",
      );
      expect(res.getHeader("X-Frame-Options")).toBe(remote ? undefined : "DENY");
      res.destroy();
      req.destroy();
    }
  });

  it("refuses stale admission and rechecks authority after asynchronous compression", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let current = true;
    const req = remoteRequest("/", {
      current: () => {
        if (!current) {
          throw new Error("grant revoked");
        }
      },
    });
    req.headers["accept-encoding"] = "gzip";
    const res = new ServerResponse(req);
    const response = sendControlUiHtmlBody(req, res, "<html>revoked while encoding fixture</html>");
    current = false;
    await expect(response).rejects.toThrow("grant revoked");
    expect(res.writableEnded).toBe(false);
    const handler = createGatewayHttpRequestHandler({
      clients: new Set(),
      controlUiBasePath: "",
      resolvedAuth: AUTH_TOKEN,
      getRuntimeConfig: () => ({}),
      handleHooksRequest: async () => false,
    });
    try {
      await expect(handler(req, res)).resolves.toBeUndefined();
      expect(res.destroyed).toBe(true);
    } finally {
      handler.dispose();
      res.destroy();
      req.destroy();
      errors.mockRestore();
    }
  });

  it("separates sandbox resources and extends its entire contextual ancestor chain", async () => {
    const sandbox = createSandboxHostHttpRequestHandler();
    for (const path of [
      "/mcp-app-sandbox",
      "/control-ui-config.json",
      "/api/artifacts/download/client/ticket",
    ]) {
      const req = remoteRequest(path);
      const res = new ServerResponse(req);
      await sandbox(req, res);
      expect(res.statusCode).toBe(path === "/mcp-app-sandbox" ? 200 : 404);
      if (res.statusCode === 200) {
        expect(res.getHeader("Content-Security-Policy")).toContain(
          "frame-ancestors https://ui.example.test https://chat.example.test codex-sandbox:",
        );
      }
      res.destroy();
      req.destroy();
    }
  });

  it.each([
    "*",
    "http://chat.example.test",
    "https:",
    "https://chat.example.test/path",
    "https://user@chat.example.test",
    "https://chat.example.test; script-src *",
  ])("rejects an unsafe frame ancestor %s", (value) => {
    expect(() => validateRemoteControlUiFrameAncestors([value])).toThrow();
  });
});
