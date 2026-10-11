import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import type {
  GatewayControlUiIngressOpenOptionsV1,
  GatewayControlUiIngressV1,
} from "../plugins/gateway-ingress.types.js";
import { createSandboxHostHttpRequestHandler } from "./mcp-app-sandbox-http.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";

const handles = new Set<GatewayControlUiIngressV1>();
afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.close()));
  handles.clear();
});

function fixture() {
  const ws = new WebSocketServer({ noServer: true });
  const host: GatewayControlUiIngressHost = {
    controlUiBasePath: "/claw",
    getResolvedAuth: () => ({
      mode: "token",
      token: "synthetic-ingress-test",
      allowTailscale: false,
    }),
    getRuntimeConfig: () => ({}),
    signal: new AbortController().signal,
    handleRequest: async (req, res) => {
      res.end(JSON.stringify(req.headers));
    },
    handleSandboxRequest: async (_req, res) => {
      res.end("sandbox");
    },
    handleUpgrade: async (req, socket, head) => {
      ws.handleUpgrade(req, socket, head, () => {});
    },
  };
  const options: GatewayControlUiIngressOpenOptionsV1 = {
    audienceId: "test-grant",
    publicOrigin: "https://ui.example.test",
    sandboxOrigin: "https://sandbox.example.test",
    frameAncestors: ["https://host.example.test", "codex-sandbox:"],
    operatorScopeCeiling: ["operator.read", "operator.write"],
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
  const factory = () =>
    createGatewayControlUiIngressFactory({
      pluginId: "test-plugin",
      host,
      signal: host.signal,
      assertCurrent: () => {},
    });
  const open = async (overrides: Partial<GatewayControlUiIngressOpenOptionsV1> = {}) => {
    const handle = await factory().open({ ...options, ...overrides });
    handles.add(handle);
    return handle;
  };
  return { host, options, factory, open };
}

function request(handle: GatewayControlUiIngressV1, pathAndQuery = "/claw/") {
  return handle.request({
    surface: "control-ui",
    method: "GET",
    pathAndQuery,
    headers: [],
    signal: new AbortController().signal,
  });
}

describe("remote Control UI handle", () => {
  it.each(["token", "password"] as const)(
    "rejects a redacted configured %s before opening transport",
    async (mode) => {
      const { host, open } = fixture();
      host.getResolvedAuth = () => ({ mode, [mode]: REDACTED_SENTINEL, allowTailscale: false });
      await expect(open()).rejects.toMatchObject({
        code: "unsupported-auth",
        message: expect.stringContaining("redacted Gateway credential"),
      });
    },
  );
  it("preserves the sandbox owner's origin isolation header through the handle", async () => {
    const { host, open } = fixture();
    host.handleSandboxRequest = createSandboxHostHttpRequestHandler();
    const { response } = await (
      await open({
        frameAncestors: [
          "codex-sandbox:",
          "https://*.web-sandbox.oaiusercontent.com",
          "https://chatgpt.com",
        ],
      })
    ).request({
      surface: "sandbox",
      method: "GET",
      pathAndQuery: "/mcp-app-sandbox",
      headers: [],
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("origin-agent-cluster")).toBe("?1");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://ui.example.test codex-sandbox: https://*.web-sandbox.oaiusercontent.com https://chatgpt.com",
    );
    await response.body?.cancel();
  });
  it("validates a relative redirect against the requested document path", async () => {
    const { host, open } = fixture();
    host.handleRequest = async (_req, res) => {
      res.writeHead(302, { Location: "new" });
      res.end();
    };
    const { response } = await request(await open());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("new");
    await response.body?.cancel();
  });
  it("settles the request owner before publishing a forbidden redirect failure", async () => {
    const { host, open } = fixture();
    const retired = createDeferred();
    const release = createDeferred();
    host.handleRequest = async (req, res) => {
      req.socket.once("close", () => retired.resolve());
      res.writeHead(302, { Location: "https://outside.example.test/" });
      res.flushHeaders();
      await release.promise;
    };
    const handle = await open();
    let settled = false;
    const pending = request(handle).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await retired.promise;
      expect(settled).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ code: "forbidden" });
  });
  it("rejects invalid HTTP bytes and duplicate WebSocket protocols before transport allocation", async () => {
    const { open, options } = fixture();
    const handle = await open();
    await expect(
      handle.request({
        surface: "control-ui",
        method: "GET",
        pathAndQuery: "/claw/",
        headers: [["accept", "\u0100"]],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(
      handle.openWebSocket({
        pathAndQuery: "/claw",
        origin: options.publicOrigin,
        protocols: ["chat", "chat"],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    const { response } = await request(handle);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
  it("retires contextual origin authority when the Gateway publishes a changed origin policy", async () => {
    const { host, open } = fixture();
    const origins = ["https://direct.example.test"];
    host.getRuntimeConfig = () => ({ gateway: { controlUi: { allowedOrigins: origins } } });
    const handle = await open();
    const first = await request(handle);
    await first.response.body?.cancel();
    origins.push("https://new.example.test");
    await expect(request(handle)).rejects.toMatchObject({
      code: "closed",
      message: expect.stringContaining("origin policy changed"),
    });
    const reopened = await request(await open());
    expect(reopened.response.status).toBe(200);
    await reopened.response.body?.cancel();
  });
  it.each(["none", "trusted-proxy"] as const)(
    "rejects unsupported %s auth with actionable typed error",
    async (mode) => {
      const { host, open } = fixture();
      host.getResolvedAuth = () => ({ mode, allowTailscale: false });
      await expect(open()).rejects.toMatchObject({
        name: "GatewayControlUiIngressError",
        code: "unsupported-auth",
        message: expect.stringContaining("token or password"),
      });
    },
  );

  it("rejects role-configured Gateways at open and after config publication", async () => {
    const { host, open } = fixture();
    const handle = await open();
    host.getRuntimeConfig = () => ({ gateway: { roles: { definitions: {} } } });
    await expect(open()).rejects.toMatchObject({
      code: "unsupported-auth",
      message: expect.stringContaining("gateway.roles"),
    });
    await expect(request(handle)).rejects.toMatchObject({ code: "unsupported-auth" });
  });

  it.each([
    { publicOrigin: "http://ui.example.test" },
    { publicOrigin: "https://ui.example.test/path" },
    { publicOrigin: "https://user@ui.example.test" },
    { sandboxOrigin: "https://ui.example.test" },
    { frameAncestors: ["*"] },
    { frameAncestors: ["https://*"] },
    { frameAncestors: ["http://*.example.test"] },
    { frameAncestors: ["https://ui.*.example.test"] },
    { frameAncestors: ["https://*example.test"] },
    { frameAncestors: ["https://**.example.test"] },
    { frameAncestors: ["https://*.example.test:443"] },
    { frameAncestors: ["https://*.example.test/path"] },
    { frameAncestors: ["https://*.example..test"] },
    { frameAncestors: ["https://*.-example.test"] },
  ])(
    "rejects unsafe presentation $publicOrigin $sandboxOrigin $frameAncestors",
    async (overrides) => {
      await expect(fixture().open(overrides)).rejects.toMatchObject({ code: "invalid-options" });
    },
  );

  it.each([
    "https://other.test/",
    "//other.test/",
    "/claw/../api",
    "/claw/%2e%2e/api",
    "/claw/%5capi",
    "/claw/\\api",
  ])("rejects ambiguous target %s before dispatch", async (path) => {
    const { host, open } = fixture();
    host.handleRequest = async () => {
      throw new Error("must not dispatch");
    };
    await expect(request(await open(), path)).rejects.toMatchObject({ code: "invalid-options" });
  });

  it("pins immutable presentation and filters browser identity and framing headers", async () => {
    const { open } = fixture();
    const ancestors = ["https://host.example.test"];
    const handle = await open({ frameAncestors: ancestors });
    ancestors.push("https://later.example.test");
    expect(Object.isFrozen(handle.presentation)).toBe(true);
    expect(Object.isFrozen(handle.presentation.operatorScopeCeiling)).toBe(true);
    const { response } = await handle.request({
      surface: "control-ui",
      method: "GET",
      pathAndQuery: "/claw/",
      signal: new AbortController().signal,
      headers: [
        ["host", "localhost"],
        ["x-forwarded-for", "127.0.0.1"],
        ["tailscale-user-login", "owner@example.test"],
        ["x-openclaw-scopes", "operator.admin"],
        ["authorization", "Bearer synthetic-device"],
        ["origin", "null"],
      ],
    });
    expect(await response.json()).toMatchObject({
      host: "ui.example.test",
      authorization: "Bearer synthetic-device",
      origin: "null",
    });
  });

  it("holds HTTP quotas through unread response bodies across independent factories", async () => {
    const { open } = fixture();
    const opened = await Promise.all(Array.from({ length: 4 }, () => open()));
    for (const handle of opened) {
      await Promise.all(Array.from({ length: 16 }, () => request(handle)));
      await expect(request(handle)).rejects.toMatchObject({ code: "limit-exceeded" });
    }
    const extra = await open();
    await expect(request(extra)).rejects.toMatchObject({ code: "limit-exceeded" });
    await opened[0]!.close();
    const { response } = await request(extra);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("bounds main, auxiliary and plugin sockets separately", async () => {
    const { open, options } = fixture();
    const first = await open();
    const connect = (handle: GatewayControlUiIngressV1, pathAndQuery: string) =>
      handle.openWebSocket({
        pathAndQuery,
        origin: options.publicOrigin,
        protocols: [],
        signal: new AbortController().signal,
      });
    await connect(first, "/claw");
    await connect(first, "/claw");
    await expect(connect(first, "/claw")).rejects.toMatchObject({ code: "limit-exceeded" });
    await connect(first, "/desktop/observe?token=synthetic");
    await connect(first, "/browser/screencast?token=synthetic");
    await expect(connect(first, "/desktop/audio")).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    for (let index = 0; index < 2; index += 1) {
      const next = await open();
      await connect(next, "/claw");
      await connect(next, "/claw");
    }
    await expect(connect(await open(), "/claw")).rejects.toMatchObject({ code: "limit-exceeded" });
    await expect(connect(first, "/browser/extension")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("fences closure and joins work already admitted by the canonical owner", async () => {
    const { host, open } = fixture();
    const entered = createDeferred();
    const release = createDeferred();
    host.handleRequest = async (_req, res) => {
      res.write("pending");
      entered.resolve();
      await release.promise;
      res.end();
    };
    const handle = await open();
    const loading = request(handle);
    await entered.promise;
    const { response } = await loading;
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await expect(request(handle)).rejects.toMatchObject({ code: "closed" });
    await expect(response.text()).rejects.toThrow();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    expect(closed).toBe(true);
  });
});
