import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import type {
  GatewayControlUiIngressOpenOptionsV2,
  GatewayControlUiIngressRequestV1,
  GatewayControlUiIngressV2,
  GatewayControlUiIngressWebSocketRequestV1,
} from "../plugins/gateway-ingress.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { authorizeControlUiReadHttpGatewayConnect } from "./auth.js";
import { prepareGatewayIngressAttribution } from "./ingress-attribution.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
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

function fixture(hostOverrides: Partial<GatewayControlUiIngressHost> = {}) {
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
    ...hostOverrides,
  };
  const options: GatewayControlUiIngressOpenOptionsV2 = createRemoteControlUiIngressTestContext();
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

function request(
  handle: GatewayControlUiIngressV2,
  pathAndQuery = "/claw/",
  overrides: Partial<GatewayControlUiIngressRequestV1> = {},
) {
  return handle.request({
    surface: "control-ui",
    method: "GET",
    pathAndQuery,
    headers: [],
    signal: new AbortController().signal,
    ...overrides,
  });
}

function connect(
  handle: GatewayControlUiIngressV2,
  overrides: Partial<GatewayControlUiIngressWebSocketRequestV1> = {},
) {
  return handle.openWebSocket({
    pathAndQuery: "/claw",
    origin: handle.presentation.publicOrigin,
    protocols: [],
    signal: new AbortController().signal,
    ...overrides,
  });
}

function expectIngressError(pending: Promise<unknown>, code: string, message?: string) {
  return expect(pending).rejects.toMatchObject({
    code,
    ...(message ? { message: expect.stringContaining(message) } : {}),
  });
}

describe("remote Control UI handle", () => {
  it("requires an explicit principal on the principal-aware host", async () => {
    const { factory, options } = fixture();
    const { principal: _principal, ...legacyOptions } = options;
    await expectIngressError(
      factory().open(legacyOptions as GatewayControlUiIngressOpenOptionsV2),
      "invalid-options",
    );
  });

  it.each([
    [{ mode: "password", password: REDACTED_SENTINEL }, "redacted Gateway credential"],
    [{ mode: "trusted-proxy" }, "token or password"],
  ] as const)("rejects unsupported auth %j", async (auth, message) => {
    const { open } = fixture({ getResolvedAuth: () => ({ ...auth, allowTailscale: false }) });
    await expect(open()).rejects.toMatchObject({
      name: "GatewayControlUiIngressError",
      code: "unsupported-auth",
      message: expect.stringContaining(message),
    });
  });
  it.each([
    ["new", 302],
    ["https://outside.example.test/", "forbidden"],
  ] as const)("validates redirect %s", async (location, expected) => {
    const { open } = fixture({
      handleRequest: async (_req, res) => {
        res.writeHead(302, { Location: location });
        res.end();
      },
    });
    const pending = request(await open());
    if (expected === "forbidden") {
      await expectIngressError(pending, expected);
    } else {
      const { response } = await pending;
      expect(response.status).toBe(expected);
      expect(response.headers.get("location")).toBe(location);
      await response.body?.cancel();
    }
  });

  it("rejects invalid HTTP bytes and duplicate WebSocket protocols through native parsers", async () => {
    const handle = await fixture().open();
    await expect(request(handle, "/claw/", { headers: [["accept", "\u0100"]] })).rejects.toThrow();
    await expect(connect(handle, { protocols: ["chat", "chat"] })).rejects.toThrow();
    const { response } = await request(handle);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
  it("retires contextual origin authority when the Gateway publishes a changed origin policy", async () => {
    const origins = ["https://direct.example.test"];
    const { open } = fixture({
      getRuntimeConfig: () => ({ gateway: { controlUi: { allowedOrigins: origins } } }),
    });
    const handle = await open();
    const first = await request(handle);
    await first.response.body?.cancel();
    origins.push("https://new.example.test");
    await expectIngressError(request(handle), "closed", "origin policy changed");
    const reopened = await request(await open());
    expect(reopened.response.status).toBe(200);
    await reopened.response.body?.cancel();
  });
  it("rejects role-configured Gateways at open and after config publication", async () => {
    const { host, open } = fixture();
    const handle = await open();
    host.getRuntimeConfig = () => ({ gateway: { roles: { definitions: {} } } });
    await expectIngressError(open(), "unsupported-auth", "gateway.roles");
    await expectIngressError(request(handle), "unsupported-auth");
  });

  it.each([
    { publicOrigin: "http://ui.example.test" },
    { publicOrigin: "https://user@ui.example.test" },
    { sandboxOrigin: "https://ui.example.test" },
    { frameAncestors: ["*"] },
    { frameAncestors: ["http://*.example.test"] },
    { frameAncestors: ["https://ui.*.example.test"] },
  ])("rejects unsafe presentation %j", async (overrides) => {
    await expectIngressError(fixture().open(overrides), "invalid-options");
  });

  it.each(["//other.test/", "/claw/%2e%2e/api", "/claw/%5capi", "/claw/\\api"])(
    "rejects ambiguous target %s before dispatch",
    async (path) => {
      const { open } = fixture({
        handleRequest: async () => {
          throw new Error("must not dispatch");
        },
      });
      await expectIngressError(request(await open(), path), "invalid-options");
    },
  );

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
    const { response } = await request(handle, "/claw/", {
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
      await expectIngressError(connect(handle, { origin }), "forbidden");
    }
  });

  it("bounds concurrent HTTP requests per handle", async () => {
    const handle = await fixture().open();
    await Promise.all(Array.from({ length: 16 }, () => request(handle)));
    await expectIngressError(request(handle), "limit-exceeded");
  });

  it("bounds main and auxiliary sockets independently", async () => {
    const { open } = fixture();
    const handle = await open();
    for (const path of ["/claw", "/claw", "/desktop/observe", "/browser/screencast"]) {
      await connect(handle, { pathAndQuery: path });
    }
    for (const path of ["/claw", "/desktop/audio"]) {
      await expectIngressError(connect(handle, { pathAndQuery: path }), "limit-exceeded");
    }
    await expectIngressError(connect(handle, { pathAndQuery: "/browser/extension" }), "forbidden");
  });
});
