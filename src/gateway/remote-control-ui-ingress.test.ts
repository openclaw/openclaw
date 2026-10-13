import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import type {
  GatewayControlUiIngressOpenOptionsV2,
  GatewayControlUiIngressV2,
} from "../plugins/gateway-ingress.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { authorizeControlUiReadHttpGatewayConnect } from "./auth.js";
import { prepareGatewayIngressAttribution } from "./ingress-attribution.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "ingress-capability", layout: "state-only" });
});
afterAll(async () => {
  await state?.cleanup();
});

const handles = new Set<GatewayControlUiIngressV2>();
afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.close()));
  handles.clear();
});

function fixture() {
  const ws = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
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
  const options: GatewayControlUiIngressOpenOptionsV2 = {
    audienceId: "test-grant",
    principal: { kind: "owner" },
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
  const open = async (overrides: Partial<GatewayControlUiIngressOpenOptionsV2> = {}) => {
    const handle = await factory().open({ ...options, ...overrides });
    handles.add(handle);
    return handle;
  };
  return { host, options, factory, open };
}

function request(handle: GatewayControlUiIngressV2, pathAndQuery = "/claw/") {
  return handle.request({
    surface: "control-ui",
    method: "GET",
    pathAndQuery,
    headers: [],
    signal: new AbortController().signal,
  });
}

describe("remote Control UI handle", () => {
  it("requires an explicit principal on the principal-aware host", async () => {
    const { factory, options } = fixture();
    const { principal: _principal, ...legacyOptions } = options;
    await expect(
      factory().open(legacyOptions as GatewayControlUiIngressOpenOptionsV2),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });

  it.each(["token", "password"] as const)("opens a %s-authenticated host", async (mode) => {
    const { host, open } = fixture();
    host.getResolvedAuth = () => ({ mode, [mode]: "synthetic-credential", allowTailscale: false });
    const { response } = await request(await open());
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

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
  it.each([
    ["new", 302],
    ["https://outside.example.test/", "forbidden"],
  ] as const)("validates redirect %s", async (location, expected) => {
    const { host, open } = fixture();
    host.handleRequest = async (_req, res) => {
      res.writeHead(302, { Location: location });
      res.end();
    };
    const pending = request(await open());
    if (expected === "forbidden") {
      await expect(pending).rejects.toMatchObject({ code: expected });
    } else {
      const { response } = await pending;
      expect(response.status).toBe(expected);
      expect(response.headers.get("location")).toBe(location);
      await response.body?.cancel();
    }
  });

  it("rejects invalid HTTP bytes and duplicate WebSocket protocols through native parsers", async () => {
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
    ).rejects.toThrow();
    await expect(
      handle.openWebSocket({
        pathAndQuery: "/claw",
        origin: options.publicOrigin,
        protocols: ["chat", "chat"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
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

  it("pins granted scopes and filters browser identity headers", async () => {
    const { host, open } = fixture();
    host.handleRequest = async (req, res) => {
      expect(
        prepareGatewayIngressAttribution({ req, trustedProxies: ["127.0.0.1"] }),
      ).toMatchObject({
        kind: "remote-forwarded",
        rateLimit: { subject: { key: "remote-control-ui:test-plugin" } },
      });
      await expect(
        authorizeControlUiReadHttpGatewayConnect({
          req,
          auth: host.getResolvedAuth(),
          connectAuth: { token: "synthetic-ingress-test" },
        }),
      ).resolves.toEqual({ ok: false, reason: "remote_control_ui_device_auth_required" });
      res.end(JSON.stringify(req.headers));
    };
    const scopes = ["operator.read"];
    const handle = await open({ operatorScopeCeiling: scopes });
    scopes.push("operator.admin");
    expect(handle.presentation.operatorScopeCeiling).toEqual(["operator.read"]);
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
    const headers = await response.json();
    expect(headers).toMatchObject({
      host: "ui.example.test",
      authorization: "Bearer synthetic-device",
      origin: "null",
    });
    for (const name of ["x-forwarded-for", "tailscale-user-login", "x-openclaw-scopes"]) {
      expect(headers).not.toHaveProperty(name);
    }
  });

  it("requires the exact handle origin despite a permissive global policy", async () => {
    const { host, open, options } = fixture();
    host.getRuntimeConfig = () => ({
      gateway: {
        controlUi: { allowedOrigins: ["*"], dangerouslyAllowHostHeaderOriginFallback: true },
      },
    });
    const handle = await open();
    for (const origin of [
      "",
      "null",
      `${options.publicOrigin}/`,
      "https://other.example.test",
      "http://localhost",
    ]) {
      await expect(
        handle.openWebSocket({
          pathAndQuery: "/claw",
          origin,
          protocols: [],
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("bounds concurrent HTTP requests per handle", async () => {
    const handle = await fixture().open();
    await Promise.all(Array.from({ length: 16 }, () => request(handle)));
    await expect(request(handle)).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("bounds main and auxiliary sockets independently", async () => {
    const { open, options } = fixture();
    const handle = await open();
    const connect = (pathAndQuery: string) =>
      handle.openWebSocket({
        pathAndQuery,
        origin: options.publicOrigin,
        protocols: [],
        signal: new AbortController().signal,
      });
    for (const path of ["/claw", "/claw", "/desktop/observe", "/browser/screencast"]) {
      await connect(path);
    }
    for (const path of ["/claw", "/desktop/audio"]) {
      await expect(connect(path)).rejects.toMatchObject({ code: "limit-exceeded" });
    }
    await expect(connect("/browser/extension")).rejects.toMatchObject({ code: "forbidden" });
  });
});
