import { ServerResponse, type IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { sendControlUiHtmlBody } from "./control-ui-static.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { resolveRemoteControlUiHttpRoute } from "./remote-control-ui-http-routing.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import { AUTH_TOKEN, createRequest, createResponse } from "./server-http.test-harness.js";

function remoteRequest(path: string, options: { current?: () => void; remote?: boolean } = {}) {
  const req = createRequest({ path, method: "GET", host: "ui.example.test" });
  if (options.remote !== false) {
    const context = createRemoteControlUiIngressTestContext({
      frameAncestors: ["https://chat.example.test", "codex-sandbox:"],
      assertCurrent: options.current ?? (() => {}),
    });
    markGatewayIngressTransport(req, { kind: "remote-forwarded", context });
  }
  return req;
}

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

it("allows declared panels without letting plugin routes claim native documents", () => {
  const registry = createEmptyPluginRegistry();
  for (const route of [
    { pluginId: "panel", path: "/reports", match: "prefix", auth: "gateway" },
    { pluginId: "webhook", path: "/webhook", match: "prefix", auth: "plugin" },
    { pluginId: "webhook", path: "/claw/settings/plugins", match: "exact", auth: "plugin" },
  ] as const) {
    registry.httpRoutes.push({ ...route, source: "fixture", handler: () => true });
  }
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
    for (const [path, owner] of [
      ["/reports/asset.js", "plugin-panel"],
      ["/webhook/event", undefined],
      ["/claw/settings/plugins", "document"],
      ["/claw/assets/app.js", "document"],
      ["/api/chat/media/outgoing/file", "outgoing-media"],
      ["/api/artifacts/download/connection/ticket", "artifact"],
      ["/__openclaw__/board/session/widget/index.html", "board"],
      ["/claw/__openclaw__/plugins/control-ui/plugin/revision/app.js", "native-assets"],
    ] as const) {
      expect(
        resolveRemoteControlUiHttpRoute(remoteRequest(path), "/claw", ["operator.read"]),
        path,
      ).toBe(owner);
    }
  });
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
