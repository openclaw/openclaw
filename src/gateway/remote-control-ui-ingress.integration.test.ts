import { on, once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV1,
  type GatewayControlUiIngressV1,
} from "../plugins/gateway-ingress.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createSandboxHostHttpRequestHandler } from "./mcp-app-sandbox-http.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { withMcpRelayIngress } from "./remote-control-ui-mcp-relay.test-support.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import { createGatewayWsTestRequestContext } from "./server/ws-connection.test-helpers.js";

vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: (await import("./remote-control-ui-mcp-relay.test-support.js")).McpRelayTestSocket,
}));

const PUBLIC_ORIGIN = "https://ui.example.test";
const SANDBOX_ORIGIN = "https://sandbox.ui.example.test";
const FRAME_ANCESTORS = [
  "codex-sandbox:",
  "https://*.web-sandbox.oaiusercontent.com",
  "https://chatgpt.com",
];
const SHARED_TOKEN = "remote-control-ui-integration-shared-token";
const SCOPES = ["operator.read", "operator.write"] as const;
const CLIENT = {
  id: "openclaw-control-ui",
  version: "dev",
  platform: "browser",
  mode: "webchat",
} as const;

type IngressFrame = {
  type: string;
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: {
    nonce?: string;
    type?: string;
    controlUiUrl?: string;
    sandboxUrl?: string;
    sandboxOrigin?: string;
    auth?: { method: string; role: string; scopes: string[]; deviceToken?: string };
    pending?: unknown[];
    paired?: Array<{
      deviceId: string;
      scopes: string[];
      approvedVia: string;
      tokens: Array<{ role: string; scopes: string[]; revokedAtMs?: number }>;
    }>;
    triggers?: string[];
  };
  error?: { code: string; message: string };
};

type Peer = {
  send(frame: unknown): Promise<void>;
  read(): Promise<IngressFrame>;
  close(): Promise<void>;
};

type ConnectOptions = {
  identity?: DeviceIdentity;
  auth?: { token?: string; password?: string; deviceToken?: string; bootstrapToken?: string };
  scopes?: string[];
  role?: string;
  owner?: boolean;
  tamperSignature?: boolean;
};

async function request(peer: Peer, method: string, params: unknown): Promise<IngressFrame> {
  await peer.send({ type: "req", id: method, method, params });
  for (;;) {
    const frame = await peer.read();
    if (frame.type === "res" && frame.id === method) {
      return frame;
    }
  }
}

async function connect(peer: Peer, options: ConnectOptions): Promise<IngressFrame> {
  const challenge = await peer.read();
  expect(challenge.event).toBe("connect.challenge");
  const nonce = challenge.payload?.nonce;
  if (!nonce) {
    throw new Error("Missing device challenge nonce");
  }
  const client = options.owner ? { ...CLIENT, id: "cli", mode: "cli" } : CLIENT;
  const role = options.role ?? "operator";
  const signedAt = Date.now();
  const identity = options.identity;
  const payload = identity
    ? buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        role,
        scopes: options.scopes ?? [],
        signedAtMs: signedAt,
        token:
          options.auth?.deviceToken ?? options.auth?.bootstrapToken ?? options.auth?.token ?? null,
        nonce,
      })
    : undefined;
  return await request(peer, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role,
    scopes: options.scopes,
    auth: options.auth,
    ...(identity && payload
      ? {
          device: {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            signature: signDevicePayload(
              identity.privateKeyPem,
              options.tamperSignature ? `${payload}-tampered` : payload,
            ),
            signedAt,
            nonce,
          },
        }
      : {}),
  });
}

function expectHello(frame: IngressFrame, method: string, scopes: readonly string[]): string {
  expect(frame).toMatchObject({
    ok: true,
    payload: { type: "hello-ok", auth: { method, role: "operator", scopes } },
  });
  const token = frame.payload?.auth?.deviceToken;
  if (!token) {
    throw new Error("Hello did not issue an ordinary device token");
  }
  return token;
}

async function usePeer<T>(peer: Peer, run: (peer: Peer) => Promise<T>): Promise<T> {
  try {
    return await run(peer);
  } finally {
    await peer.close();
  }
}

async function expectReadWriteWithoutAdmin(peer: Peer, trigger: string) {
  expect(await request(peer, "voicewake.set", { triggers: [trigger] })).toMatchObject({
    ok: true,
    payload: { triggers: [trigger] },
  });
  expect(await request(peer, "voicewake.get", {})).toMatchObject({
    ok: true,
    payload: { triggers: [trigger] },
  });
  expect(await request(peer, "config.set", { raw: "{}" })).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
}

describe("remote Control UI ingress production composition", () => {
  let state: OpenClawTestState;
  let ingress: GatewayControlUiIngressV1 | undefined;
  let factory: GatewayControlUiIngressFactoryV1;
  let config: OpenClawConfig;
  let auth: ResolvedGatewayAuth;
  let gatewayContext: GatewayRequestContext;
  let http: ReturnType<typeof createGatewayHttpRequestHandler> | undefined;
  const hostLifetime = new AbortController();
  const serviceLifetime = new AbortController();
  const grantLifetime = new AbortController();
  const clients = new GatewayClientRegistry();
  let listener: Awaited<
    ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>
  >;
  const connectionWork = new GatewayConnectionWork();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const openOptions = {
    audienceId: "synthetic-integration-grant",
    publicOrigin: PUBLIC_ORIGIN,
    sandboxOrigin: SANDBOX_ORIGIN,
    operatorScopeCeiling: SCOPES,
    frameAncestors: FRAME_ANCESTORS,
    signal: grantLifetime.signal,
    assertCurrent: () => grantLifetime.signal.throwIfAborted(),
  };

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "remote-control-ui-ingress",
      layout: "state-only",
    });
    const root = path.dirname(
      await state.writeText(
        "ui/index.html",
        '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body>Remote UI fixture</body></html>',
      ),
    );
    await state.writeText("ui/assets/app.js", 'document.body.dataset.ready = "remote-ui";');
    config = {
      gateway: {
        auth: { mode: "token", token: SHARED_TOKEN },
        publicOrigin: "https://direct.example.test",
        controlUi: { enabled: true, basePath: "/claw", root },
      },
      mcp: { apps: { sandboxOrigin: "https://direct-sandbox.example.test" } },
      skills: { load: { watch: false } },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config, config);
    auth = { mode: "token", token: SHARED_TOKEN, allowTailscale: false };
    const logger = createSubsystemLogger("test/remote-control-ui-ingress");
    const requestContext = {
      ...createGatewayWsTestRequestContext(),
      getRuntimeConfig: () => config,
      logGateway: logger,
      broadcastVoiceWakeChanged: () => {},
      getMcpAppSandboxPort: () => 443,
      isConnectionActive: (connId: string) => Boolean(clients.getByConnectionId(connId)),
    };
    Object.assign(requestContext, { resolveGatewayContext: () => requestContext });
    gatewayContext = requestContext as never;
    const preauthConnectionBudget = createPreauthConnectionBudget(8);
    attachGatewayWsConnectionHandler({
      wss,
      clients,
      connectionWork,
      preauthConnectionBudget,
      bootId: "remote-control-ui-test-boot",
      port: 0,
      getResolvedAuth: () => auth,
      gatewayMethods: [],
      events: [],
      extraHandlers: {},
      refreshHealthSnapshot: async () => ({
        ok: true,
        ts: 1,
        durationMs: 0,
        channels: {},
        channelOrder: [],
        channelLabels: {},
        heartbeatSeconds: 0,
        agents: [],
        sessions: { path: "", count: 0, recent: [] },
      }),
      logGateway: logger,
      logHealth: logger,
      logWsControl: logger,
      broadcast: requestContext.broadcast,
      buildRequestContext: () => gatewayContext,
    });
    http = createGatewayHttpRequestHandler({
      clients,
      controlUiEnabled: true,
      controlUiBasePath: "/claw",
      controlUiRoot: { kind: "resolved", path: root },
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
      getRuntimeConfig: () => config,
      handleHooksRequest: async () => false,
    });
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () => createServer(),
    });
    const handleUpgrade = attachGatewayUpgradeHandler({
      httpServer: listener.listener,
      wss,
      clients,
      preauthConnectionBudget,
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
      controlUiBasePath: "/claw",
    });
    factory = createGatewayControlUiIngressFactory({
      pluginId: "synthetic-bundled-plugin",
      signal: serviceLifetime.signal,
      assertCurrent: () => serviceLifetime.signal.throwIfAborted(),
      host: {
        controlUiBasePath: "/claw",
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => config,
        handleRequest: http,
        handleUpgrade,
        handleSandboxRequest: createSandboxHostHttpRequestHandler(),
        signal: hostLifetime.signal,
      },
    });
    ingress = await factory.open(openOptions);
  });

  afterAll(async () => {
    await ingress?.close();
    hostLifetime.abort();
    serviceLifetime.abort();
    await connectionWork.drain();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    http?.dispose();
    await listener?.releaseListener();
    await listener?.claim.release();
    await state?.cleanup();
  });

  async function openRemote(handle = ingress): Promise<Peer> {
    if (!handle) {
      throw new Error("Missing ingress fixture");
    }
    const { socket } = await handle.openWebSocket({
      pathAndQuery: "/claw",
      origin: PUBLIC_ORIGIN,
      protocols: [],
      signal: grantLifetime.signal,
    });
    const messages = socket.messages[Symbol.asyncIterator]();
    return {
      send: async (frame) => socket.send({ kind: "text", text: JSON.stringify(frame) }),
      read: async () => {
        const frame = await messages.next();
        if (frame.done || frame.value.kind !== "text") {
          throw new Error("Expected a Gateway JSON frame");
        }
        return JSON.parse(frame.value.text) as IngressFrame;
      },
      close: async () => {
        socket.close();
        await socket.closed;
        await messages.return?.();
      },
    };
  }

  async function openDirect(owner = false): Promise<Peer> {
    const url = `ws://127.0.0.1:${listener.claim.port}/claw`;
    const socket = new WebSocket(
      url,
      owner ? {} : { origin: `http://127.0.0.1:${listener.claim.port}` },
    );
    const messages = on(socket, "message");
    await once(socket, "open");
    return {
      send: async (frame) => {
        await new Promise<void>((resolve, reject) => {
          socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
        });
      },
      read: async () => {
        const frame = await messages.next();
        if (frame.done) {
          throw new Error("Direct Gateway socket closed before its response");
        }
        return JSON.parse(String(frame.value[0])) as IngressFrame;
      },
      close: async () => {
        if (socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket, "close");
          socket.close();
          await closed;
        }
        await messages.return?.();
      },
    };
  }

  it("auto-approves a fresh browser and uses its ordinary capped token remotely and directly", async () => {
    for (const [pathname, expected] of [
      ["/claw/", "Remote UI fixture"],
      ["/claw/assets/app.js", 'document.body.dataset.ready = "remote-ui";'],
    ]) {
      const { response } = await ingress!.request({
        surface: "control-ui",
        method: "GET",
        pathAndQuery: pathname!,
        headers: [],
        signal: grantLifetime.signal,
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(expected);
      if (pathname === "/claw/") {
        expect(body).toContain('data-openclaw-remote-ingress="true"');
        expect(body).toContain('data-openclaw-control-ui-base-path="/claw"');
        expect(response.headers.get("content-security-policy")).toContain(
          `frame-ancestors ${FRAME_ANCESTORS.join(" ")}`,
        );
      }
    }
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-remote-browser" });
    const deviceToken = await usePeer(await openRemote(), async (peer) => {
      const hello = await connect(peer, { identity, scopes: [] });
      const token = expectHello(hello, "remote-ingress", SCOPES);
      expect(hello.payload?.controlUiUrl).toBe(`${PUBLIC_ORIGIN}/claw`);
      const preview = await request(peer, "canvas.document.preview", {
        html: "<p>Ingress preview</p>",
      });
      expect(preview).toMatchObject({ ok: true, payload: { sandboxOrigin: SANDBOX_ORIGIN } });
      const sandboxUrl = new URL(preview.payload!.sandboxUrl!);
      expect(sandboxUrl.origin).toBe(SANDBOX_ORIGIN);
      const { response } = await ingress!.request({
        surface: "sandbox",
        method: "GET",
        pathAndQuery: `${sandboxUrl.pathname}${sandboxUrl.search}`,
        headers: [],
        signal: grantLifetime.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain(
        `frame-ancestors ${PUBLIC_ORIGIN} ${FRAME_ANCESTORS.join(" ")}`,
      );
      await response.body?.cancel();
      await expectReadWriteWithoutAdmin(peer, "fresh browser");
      return token;
    });
    await usePeer(await openRemote(), async (peer) => {
      expectHello(
        await connect(peer, { identity, auth: { deviceToken }, scopes: [...SCOPES] }),
        "device-token",
        SCOPES,
      );
      await expectReadWriteWithoutAdmin(peer, "returning browser");
    });
    await usePeer(await openRemote(), async (peer) => {
      expectHello(await connect(peer, { identity }), "remote-ingress", SCOPES);
    });
    await usePeer(await openDirect(), async (peer) => {
      expectHello(
        await connect(peer, { identity, auth: { deviceToken }, scopes: [...SCOPES] }),
        "device-token",
        SCOPES,
      );
      await expectReadWriteWithoutAdmin(peer, "direct browser");
    });
    await usePeer(await openDirect(), async (peer) => {
      expect(
        await connect(peer, { identity, auth: { deviceToken }, scopes: ["operator.admin"] }),
      ).toMatchObject({ ok: false, error: { message: expect.stringContaining("device token") } });
    });
    await usePeer(await openDirect(true), async (owner) => {
      expect(
        await connect(owner, {
          owner: true,
          auth: { token: SHARED_TOKEN },
          scopes: ["operator.admin"],
        }),
      ).toMatchObject({ ok: true });
      const list = await request(owner, "device.pair.list", {});
      expect(list.ok).toBe(true);
      expect(list.payload?.pending).toEqual([]);
      expect(list.payload?.paired).toEqual([
        expect.objectContaining({
          deviceId: identity.deviceId,
          role: "operator",
          roles: ["operator"],
          scopes: [...SCOPES],
          approvedVia: "remote-ingress",
          tokens: [expect.objectContaining({ role: "operator", scopes: [...SCOPES] })],
        }),
      ]);
      expect(
        await request(owner, "device.token.revoke", {
          deviceId: identity.deviceId,
          role: "operator",
        }),
      ).toMatchObject({ ok: true });
    });
    for (const direct of [false, true]) {
      await usePeer(await (direct ? openDirect() : openRemote()), async (connection) => {
        const denied = await connect(connection, {
          identity,
          auth: { deviceToken },
          scopes: [...SCOPES],
        });
        expect(denied.ok).toBe(false);
        expect(denied.error?.message).toContain("device token");
      });
    }
  });

  it("refuses shared credentials, bootstrap tokens, invalid tokens, unbound devices, roles, and excess scopes", async () => {
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-rejected-browser" });
    const bootstrap = await issueDeviceBootstrapToken({
      profile: { purpose: "control-ui", roles: ["operator"], scopes: [...SCOPES] },
    });
    for (const credential of [
      { token: SHARED_TOKEN },
      { password: "synthetic-password" },
      { bootstrapToken: bootstrap.token },
    ]) {
      await usePeer(await openRemote(), async (peer) => {
        expect(
          await connect(peer, { identity, auth: credential, scopes: [...SCOPES] }),
        ).toMatchObject({
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: expect.stringContaining("shared Gateway credentials"),
          },
        });
      });
    }
    const deniedCases: Array<[ConnectOptions, string]> = [
      [
        { identity, auth: { deviceToken: "invalid-device-token" }, scopes: [...SCOPES] },
        "device token",
      ],
      [{ identity, scopes: [...SCOPES], tamperSignature: true }, "signature"],
      [{ scopes: [...SCOPES] }, "signed device identity"],
      [{ identity, role: "node", scopes: [] }, "operator role"],
      [{ identity, scopes: ["operator.admin"] }, "ceiling"],
    ];
    for (const [options, message] of deniedCases) {
      await usePeer(await openRemote(), async (peer) => {
        expect(await connect(peer, options)).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(message) },
        });
      });
    }
  });

  it("caps empty-scope enrollment and same-key lost-token recovery to a read-only handle", async () => {
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-narrowed-browser" });
    const originalToken = await usePeer(await openRemote(), async (peer) =>
      expectHello(await connect(peer, { identity, scopes: [] }), "remote-ingress", SCOPES),
    );
    const readOnly = await factory.open({
      ...openOptions,
      audienceId: "synthetic-read-only-grant",
      operatorScopeCeiling: ["operator.read"],
    });
    try {
      expect(readOnly.presentation).toMatchObject({
        publicOrigin: PUBLIC_ORIGIN,
        sandboxOrigin: SANDBOX_ORIGIN,
      });
      expect(ingress!.presentation).toMatchObject({
        publicOrigin: PUBLIC_ORIGIN,
        sandboxOrigin: SANDBOX_ORIGIN,
      });
      const readOnlyIdentity = loadOrCreateDeviceIdentity({
        identityKey: "synthetic-read-only-browser",
      });
      await usePeer(await openRemote(readOnly), async (peer) => {
        expectHello(await connect(peer, { identity: readOnlyIdentity }), "remote-ingress", [
          "operator.read",
        ]);
      });
      await usePeer(await openRemote(), async (peer) => {
        expectHello(
          await connect(peer, { identity: readOnlyIdentity, scopes: [...SCOPES] }),
          "remote-ingress",
          SCOPES,
        );
        await expectReadWriteWithoutAdmin(peer, "same-key scope upgrade");
      });
      const deviceToken = await usePeer(await openRemote(readOnly), async (peer) => {
        const token = expectHello(await connect(peer, { identity }), "remote-ingress", [
          "operator.read",
        ]);
        expect(await request(peer, "voicewake.get", {})).toMatchObject({ ok: true });
        expect(await request(peer, "voicewake.set", { triggers: ["denied write"] })).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", message: "missing scope: operator.write" },
        });
        return token;
      });
      expect(deviceToken).not.toBe(originalToken);
      await usePeer(await openDirect(), async (peer) => {
        expectHello(
          await connect(peer, { identity, auth: { deviceToken }, scopes: ["operator.read"] }),
          "device-token",
          ["operator.read"],
        );
        expect(
          await request(peer, "voicewake.set", { triggers: ["denied direct write"] }),
        ).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", message: "missing scope: operator.write" },
        });
      });
      await usePeer(await openDirect(), async (peer) => {
        expect(
          await connect(peer, { identity, auth: { deviceToken }, scopes: [...SCOPES] }),
        ).toMatchObject({ ok: false, error: { message: expect.stringContaining("device token") } });
      });
      for (const credential of [undefined, { deviceToken }]) {
        await usePeer(await openRemote(readOnly), async (peer) => {
          expect(
            await connect(peer, { identity, auth: credential, scopes: [...SCOPES] }),
          ).toMatchObject({
            ok: false,
            error: { code: "FORBIDDEN", message: expect.stringContaining("ceiling") },
          });
        });
      }
    } finally {
      await readOnly.close();
    }
    const { response } = await ingress!.request({
      surface: "control-ui",
      method: "GET",
      pathAndQuery: "/claw/",
      headers: [],
      signal: grantLifetime.signal,
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("tunnels the real Control UI and credential-free device connect through the MCP relay service", async () => {
    await withMcpRelayIngress(
      {
        factory,
        config,
        state,
        context: gatewayContext,
        publicOrigin: PUBLIC_ORIGIN,
        sandboxOrigin: SANDBOX_ORIGIN,
        frameAncestors: FRAME_ANCESTORS,
      },
      async (relayPeer) => {
        const hello = await connect(
          {
            send: (frame) => relayPeer.send(frame),
            read: async () => JSON.parse(await relayPeer.read()) as IngressFrame,
            close: async () => {},
          },
          {
            identity: loadOrCreateDeviceIdentity({ identityKey: "synthetic-mcp-relay-browser" }),
            scopes: [],
          },
        );
        expectHello(hello, "remote-ingress", SCOPES);
        expect(hello.payload?.controlUiUrl).toBe(`${PUBLIC_ORIGIN}/claw`);
      },
    );
  });

  it("refuses an unauthenticated host", async () => {
    await ingress!.close();
    auth = { mode: "none", allowTailscale: false };
    config = { ...config, gateway: { ...config.gateway, auth: { mode: "none" } } };
    setRuntimeConfigSnapshot(config, config);
    await expect(factory.open(openOptions)).rejects.toMatchObject({
      name: GatewayControlUiIngressError.name,
      code: "unsupported-auth",
      message: expect.stringContaining("token or password"),
    });
  });
});
