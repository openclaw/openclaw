import { on, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { saveMediaBuffer } from "../media/store.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV2,
  type GatewayControlUiIngressV2,
} from "../plugins/gateway-ingress.types.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { uploadUserBackground } from "../state/user-background.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileRole,
  setCanonicalUserProfileAvatar,
} from "../state/user-profile-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createSandboxHostHttpRequestHandler } from "./mcp-app-sandbox-http.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connect,
  request,
  expectHello,
  usePeer,
  expectReadWriteWithoutAdmin,
  expectOwnerReadAccess,
  expectUiCloseJoinsRpc,
  expectIngressDenials,
  type IngressFrame,
  type Peer,
  type ConnectOptions,
} from "./remote-control-ui-ingress.integration.test-support.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./server-methods/types.js";
import { usersHandlers } from "./server-methods/users.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import { createGatewayWsTestRequestContext } from "./server/ws-connection.test-helpers.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const PUBLIC_ORIGIN = "https://ui.example.test";
const SANDBOX_ORIGIN = "https://sandbox.ui.example.test";
const FRAME_ANCESTORS = [
  "codex-sandbox:",
  "https://*.web-sandbox.oaiusercontent.com",
  "https://chatgpt.com",
];
const SHARED_TOKEN = "remote-control-ui-integration-shared-token";
const SCOPES = ["operator.read", "operator.write"] as const;
const OWNER_SESSION_KEY = "agent:main:ingress-owner-chat";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGO4E2DzHwAF3AJov2Ds8QAAAABJRU5ErkJggg==",
  "base64",
);
describe("remote Control UI ingress production composition", () => {
  let state: OpenClawTestState;
  let ingress: GatewayControlUiIngressV2 | undefined;
  let factory: GatewayControlUiIngressFactoryV2;
  let config: OpenClawConfig;
  let auth: ResolvedGatewayAuth;
  let projection: SessionRowProjection | undefined;
  let backgroundPath: string;
  let assistantMediaPath: string;
  let heldMutation:
    | {
        entered: ReturnType<typeof createDeferred>;
        release: ReturnType<typeof createDeferred>;
        remaining: number;
      }
    | undefined;
  let heldRead:
    | { entered: ReturnType<typeof createDeferred>; release: ReturnType<typeof createDeferred> }
    | undefined;
  let observeOwnerMutation: ((options: GatewayRequestHandlerOptions) => void) | undefined;
  const extraHandlers: GatewayRequestHandlers = {
    "users.setDisplayName": async (options) => {
      observeOwnerMutation?.(options);
      const held = heldMutation;
      if (held) {
        held.remaining -= 1;
        if (held.remaining === 0) {
          held.entered.resolve(undefined);
        }
        await held.release.promise;
      }
      await usersHandlers["users.setDisplayName"]!(options);
    },
  };
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
    principal: { kind: "owner" as const },
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
    await fs.writeFile(path.join(state.workspaceDir, "favicon.png"), PNG_BYTES);
    const assistantMedia = await state.writeText("media/ingress-chat.txt", "Ingress chat media\n");
    assistantMediaPath = `/claw/__openclaw__/assistant-media?source=${encodeURIComponent(assistantMedia)}`;
    config = {
      agents: {
        defaults: { workspace: state.workspaceDir },
        entries: { main: { identity: { avatar: "favicon.png" } } },
      },
      gateway: {
        auth: { mode: "token", token: SHARED_TOKEN },
        publicOrigin: "https://direct.example.test",
        controlUi: { enabled: true, basePath: "/claw", root },
      },
      mcp: { apps: { sandboxOrigin: "https://direct-sandbox.example.test" } },
      skills: { load: { watch: false } },
      plugins: { enabled: false },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config, config);
    await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
    await setCanonicalUserProfileAvatar("gateway-owner", PNG_BYTES, "image/png");
    const background = await uploadUserBackground("gateway-owner", {
      expectedAssetId: null,
      expectedPreference: null,
      imageBase64: PNG_BYTES.toString("base64"),
    });
    if (background.status !== "ok" || !background.asset) {
      throw new Error("Synthetic owner background was not uploaded");
    }
    backgroundPath = `/claw/__openclaw__/users/background/${background.asset.assetId}`;
    const channelAvatar = await saveMediaBuffer(PNG_BYTES, "image/png", "inbound");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: OWNER_SESSION_KEY },
      {
        sessionId: "synthetic-owner-chat",
        updatedAt: Date.now(),
        label: "Owner ingress chat",
        spawnedCwd: state.workspaceDir,
        createdActor: { type: "human", source: "profile", id: "gateway-owner" },
        visibility: "shared",
        delivery: {
          kind: "external",
          route: { channel: "discord", target: { to: "user:synthetic" } },
          context: { channel: "discord", to: "user:synthetic" },
          origin: { provider: "discord", to: "user:synthetic", avatar: channelAvatar.path },
        },
      },
    );
    projection = await createSessionRowProjection({ cfg: config, modelCatalog: [] });
    auth = { mode: "token", token: SHARED_TOKEN, allowTailscale: false };
    const logger = createSubsystemLogger("test/remote-control-ui-ingress");
    const methodRegistry = createRequestGatewayMethodRegistry(extraHandlers);
    const requestContext = bindSessionRowProjection(
      {
        ...createGatewayWsTestRequestContext(),
        getRuntimeConfig: () => config,
        trackExecution: <T>(run: () => T | Promise<T>) => connectionWork.track(run),
        logGateway: logger,
        broadcastVoiceWakeChanged: () => {},
        forgetConnectionAncestors: () => {},
        getMcpAppSandboxPort: () => 443,
        getGatewayMethodRegistry: () => methodRegistry,
        isConnectionActive: (connId: string) => Boolean(clients.getByConnectionId(connId)),
      },
      () => projection,
    );
    Object.assign(requestContext, { resolveGatewayContext: () => requestContext });
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
      extraHandlers,
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
      buildRequestContext: () => requestContext as never,
    });
    http = createGatewayHttpRequestHandler({
      clients,
      controlUiEnabled: true,
      controlUiBasePath: "/claw",
      controlUiRoot: { kind: "resolved", path: root },
      resolvedAuth: auth,
      getResolvedAuth: () => auth,
      getRuntimeConfig: () => config,
      getGatewayRequestContext: () => requestContext as never,
      handleHooksRequest: async () => false,
    });
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () => createServer((req, res) => void http!(req, res)),
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
        resolveGatewayContext: () => requestContext as never,
        getResolvedAuth: () => auth,
        getRuntimeConfig: () => config,
        handleRequest: async (req, res) => {
          const held = req.url?.includes("held=1") ? heldRead : undefined;
          if (held) {
            held.entered.resolve(undefined);
            await held.release.promise;
          }
          await http!(req, res);
        },
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
    projection?.dispose();
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

  async function readRemote(pathAndQuery: string, handle = ingress!) {
    return (
      await handle.request({
        surface: "control-ui",
        method: "GET",
        pathAndQuery,
        headers: [
          ["sec-fetch-mode", "cors"],
          ["sec-fetch-site", "same-origin"],
        ],
        signal: grantLifetime.signal,
      })
    ).response;
  }

  it("serves read-only UI config, images and chat media under the grant without opening general APIs", async () => {
    const iconKey = encodeURIComponent(OWNER_SESSION_KEY);
    const imagePaths = [
      "/claw/avatar/main",
      "/claw/api/users/gateway-owner/avatar",
      `/claw/__openclaw__/workspace-icon/${iconKey}`,
      `/claw/__openclaw__/channel-avatar/${iconKey}`,
      backgroundPath,
    ];
    const directOrigin = `http://127.0.0.1:${listener.claim.port}`;
    for (const pathname of imagePaths) {
      const remote = await readRemote(pathname);
      expect(remote.status, pathname).toBe(200);
      const remoteBytes = Buffer.from(await remote.arrayBuffer());
      expect(remote.headers.get("content-type")).toBe(
        pathname === backgroundPath ? "image/jpeg" : "image/png",
      );
      const direct = await fetch(`${directOrigin}${pathname}`, {
        headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
      });
      expect(direct.status, pathname).toBe(200);
      expect(Buffer.from(await direct.arrayBuffer())).toEqual(remoteBytes);
      if (pathname !== backgroundPath) {
        expect(remoteBytes).toEqual(PNG_BYTES);
      }
    }
    const configPath = "/claw/control-ui-config.json";
    const remoteConfig = await readRemote(configPath);
    expect(remoteConfig.status).toBe(200);
    expect(await remoteConfig.json()).toMatchObject({
      basePath: "/claw",
      assistantAgentId: "main",
      assistantAvatar: expect.stringContaining("/claw/avatar/main"),
    });
    const directConfig = await fetch(`${directOrigin}${configPath}`, {
      headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
    });
    expect(directConfig.status).toBe(200);
    expect(await directConfig.json()).toMatchObject({
      basePath: "/claw",
      assistantAgentId: "main",
    });
    for (const pathname of [configPath, imagePaths[2]!]) {
      const unauthenticated = await fetch(`${directOrigin}${pathname}`);
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.body?.cancel();
    }
    const metadata = await readRemote(`${assistantMediaPath}&meta=1`);
    expect(metadata.status).toBe(200);
    const media = (await metadata.json()) as { available: boolean; mediaTicket: string };
    expect(media.available).toBe(true);
    expect(media.mediaTicket).toMatch(/^v1\./);
    const ticketedPath = `${assistantMediaPath}&mediaTicket=${encodeURIComponent(media.mediaTicket)}`;
    const remoteMedia = await readRemote(ticketedPath);
    expect(remoteMedia.status).toBe(200);
    expect(await remoteMedia.text()).toBe("Ingress chat media\n");
    const directReplay = await fetch(`${directOrigin}${ticketedPath}`);
    expect(directReplay.status).toBe(404);
    await directReplay.body?.cancel();
    for (const pathname of ["/api/sessions", "/v1/models", "/claw/__openclaw__/unknown"]) {
      const response = await readRemote(pathname);
      expect(response.status, pathname).toBe(404);
      await response.body?.cancel();
    }
  });

  it("pairs visible devices without issuing credentials and reconnects under the live owner grant", async () => {
    const document = await readRemote("/claw/");
    expect(document.status).toBe(200);
    const body = await document.text();
    expect(body).toContain('data-openclaw-remote-ingress="true"');
    expect(body).toContain('data-openclaw-control-ui-base-path="/claw"');
    expect(document.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${FRAME_ANCESTORS.join(" ")}`,
    );
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-remote-browser" });
    for (const scopes of [[], [...SCOPES], undefined]) {
      await usePeer(await openRemote(), async (peer) => {
        const hello = await connect(peer, { identity, scopes });
        expectHello(hello, "remote-ingress", SCOPES);
        expect(hello.payload?.controlUiUrl).toBe(`${PUBLIC_ORIGIN}/claw`);
        await expectOwnerReadAccess(peer, OWNER_SESSION_KEY);
        await expectIngressDenials(peer);
        await expectReadWriteWithoutAdmin(peer, "credential-free browser");
      });
    }
    await usePeer(await openDirect(), async (peer) => {
      expect(await connect(peer, { identity, scopes: [...SCOPES] })).toMatchObject({ ok: false });
    });
    await usePeer(await openDirect(true), async (owner) => {
      expect(
        await connect(owner, {
          owner: true,
          auth: { token: SHARED_TOKEN },
          scopes: ["operator.admin"],
        }),
      ).toMatchObject({ ok: true });
      const adminClient = [...clients].find((client) => client.connect.client.mode === "cli");
      if (!adminClient) {
        throw new Error("Missing authenticated administrator connection");
      }
      await withPluginRuntimeGatewayRequestScope(
        {
          client: adminClient,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: () => clients.has(adminClient),
        },
        async () => {
          await expect(ingress!.requestGateway("config.set", { raw: "{}" })).rejects.toThrow(
            "operator.admin",
          );
          expect(await ingress!.requestGateway("voicewake.get", {})).toHaveProperty("triggers");
        },
      );
      const list = await request(owner, "device.pair.list", {});
      expect(list.ok).toBe(true);
      expect(list.payload?.pending).toEqual([]);
      expect(list.payload?.paired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            deviceId: identity.deviceId,
            scopes: [...SCOPES],
            approvedVia: "remote-ingress",
          }),
        ]),
      );
    });
    const preview = await ingress!.requestGateway<{ sandboxUrl: string; sandboxOrigin: string }>(
      "canvas.document.preview",
      { html: "<p>Ingress preview</p>" },
    );
    expect(preview.sandboxOrigin).toBe(SANDBOX_ORIGIN);
    const sandboxUrl = new URL(preview.sandboxUrl);
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
  });

  it("rejects reusable credentials, invalid device proof, roles, and scopes above the grant", async () => {
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-rejected-browser" });
    for (const credential of [
      { token: SHARED_TOKEN },
      { password: "synthetic-password" },
      { bootstrapToken: "synthetic-bootstrap" },
      { deviceToken: "synthetic-device-token" },
    ]) {
      await usePeer(await openRemote(), async (peer) => {
        expect(
          await connect(peer, { identity, auth: credential, scopes: [...SCOPES] }),
        ).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", message: expect.stringContaining("credential") },
        });
      });
    }
    for (const [options, message] of [
      [{ identity, scopes: [...SCOPES], tamperSignature: true }, "signature"],
      [{ scopes: [...SCOPES] }, "signed device identity"],
      [{ identity, role: "node", scopes: [] }, "operator role"],
      [{ identity, scopes: ["operator.admin"] }, "ceiling"],
    ] as Array<[ConnectOptions, string]>) {
      await usePeer(await openRemote(), async (peer) => {
        expect(await connect(peer, options)).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(message) },
        });
      });
    }
  });

  it("enforces owner read/write and full ceilings in WS and origin-free RPC for token and password hosts", async () => {
    for (const mode of ["token", "password"] as const) {
      auth = { mode, [mode]: SHARED_TOKEN, allowTailscale: false };
      config = { ...config, gateway: { ...config.gateway, auth: { mode, [mode]: SHARED_TOKEN } } };
      setRuntimeConfigSnapshot(config, config);
      for (const ceiling of [["operator.read"], [...SCOPES], ["operator.admin"]]) {
        const binding = await factory.bindPrincipal({
          audienceId: `owner-${mode}-${ceiling.join("-")}`,
          principal: { kind: "owner" },
          operatorScopeCeiling: ceiling,
          signal: grantLifetime.signal,
          assertCurrent: () => grantLifetime.signal.throwIfAborted(),
        });
        try {
          expect(await binding.request("voicewake.get", {})).toHaveProperty("triggers");
          if (ceiling.includes("operator.read") && ceiling.length === 1) {
            await expect(
              binding.request("voicewake.set", { triggers: ["denied"] }),
            ).rejects.toThrow("operator.write");
          } else {
            expect(await binding.request("voicewake.set", { triggers: [mode] })).toMatchObject({
              triggers: [mode],
            });
          }
          if (ceiling.includes("operator.admin")) {
            expect(await binding.request("exec.approvals.get", {})).toHaveProperty(
              "resolvedDefaults",
            );
            expect(await binding.request("device.pair.list", {})).toHaveProperty("paired");
          } else {
            await expect(binding.request("config.set", { raw: "{}" })).rejects.toThrow(
              "operator.admin",
            );
          }
          const ui = await binding.openControlUi({
            publicOrigin: PUBLIC_ORIGIN,
            sandboxOrigin: SANDBOX_ORIGIN,
            frameAncestors: FRAME_ANCESTORS,
          });
          await usePeer(await openRemote(ui), async (peer) => {
            const identity = loadOrCreateDeviceIdentity({
              identityKey: `synthetic-${mode}-${ceiling.join("-")}`,
            });
            expectHello(await connect(peer, { identity }), "remote-ingress", ceiling);
            expect(await request(peer, "voicewake.get", {})).toMatchObject({ ok: true });
            expect(await request(peer, "exec.approvals.get", {})).toMatchObject({
              ok: ceiling.includes("operator.admin"),
            });
          });
        } finally {
          await binding.close();
        }
      }
    }
  });

  it("retains live owner RPC authority without inventing a WebSocket connection", async () => {
    let current = true;
    let assertRetained: (() => void) | undefined;
    const binding = await factory.bindPrincipal({
      ...openOptions,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Owner grant revoked");
        }
      },
    });
    observeOwnerMutation = ({ client }) => {
      expect(client?.connId).toBeUndefined();
      const authority = client?.internal?.operatorRunAuthority;
      expect(authority?.profileId).toBe("gateway-owner");
      if (!authority) {
        throw new Error("Missing retained owner authority");
      }
      assertRetained = authority.assertCurrent;
    };
    heldMutation = { entered: createDeferred(), release: createDeferred(), remaining: 1 };
    try {
      const pending = binding.request("users.setDisplayName", {
        profileId: "gateway-owner",
        displayName: "Must not be published",
      });
      const rejected = pending.catch((error: unknown) => error);
      await awaitGateBeforeSettlement(
        heldMutation.entered.promise,
        pending,
        "Owner mutation did not retain authority",
      );
      expect(assertRetained).toBeTypeOf("function");
      expect(() => assertRetained!()).not.toThrow();
      current = false;
      expect(() => assertRetained!()).toThrow();
      heldMutation.release.resolve(undefined);
      expect(await rejected).toBeInstanceOf(Error);
    } finally {
      heldMutation?.release.resolve(undefined);
      heldMutation = undefined;
      observeOwnerMutation = undefined;
      await binding.close();
    }
  });

  it("joins retained UI RPC execution before closing its transport handle", async () => {
    const binding = await factory.bindPrincipal(openOptions);
    const ui = await binding.openControlUi({
      publicOrigin: PUBLIC_ORIGIN,
      sandboxOrigin: SANDBOX_ORIGIN,
      frameAncestors: FRAME_ANCESTORS,
    });
    heldMutation = { entered: createDeferred(), release: createDeferred(), remaining: 1 };
    try {
      const pending = ui.requestGateway("users.setDisplayName", {
        profileId: "gateway-owner",
        displayName: "Must not be published",
      });
      await awaitGateBeforeSettlement(
        heldMutation.entered.promise,
        pending,
        "UI RPC did not enter its handler",
      );
      await expectUiCloseJoinsRpc(ui, binding, pending, () =>
        heldMutation!.release.resolve(undefined),
      );
    } finally {
      heldMutation?.release.resolve(undefined);
      heldMutation = undefined;
      await binding.close();
    }
  });

  it("reuses a signed device across independent ceilings without retaining the previous grant's scopes", async () => {
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-changing-ceiling" });
    for (const ceiling of [
      ["operator.read", "operator.questions"],
      ["operator.write"],
      ["operator.read"],
    ]) {
      const ui = await factory.open({ ...openOptions, operatorScopeCeiling: ceiling });
      try {
        await usePeer(await openRemote(ui), async (peer) => {
          expectHello(await connect(peer, { identity }), "remote-ingress", ceiling);
          expect(await request(peer, "device.pair.list", {})).toMatchObject({ ok: false });
          if (!ceiling.includes("operator.write")) {
            expect(await request(peer, "voicewake.set", { triggers: ["denied"] })).toMatchObject({
              ok: false,
            });
          }
        });
      } finally {
        await ui.close();
      }
    }
  });

  it("binds Team WS, HTTP and RPC to each person's role and session visibility", async () => {
    await ingress!.close();
    const admin = await ensureCanonicalUserProfileForEmail("admin@ingress.example.test");
    const reader = await ensureCanonicalUserProfileForEmail("reader@ingress.example.test");
    await setCanonicalUserProfileRole(admin.id, "admin", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    await setCanonicalUserProfileRole(reader.id, "reader", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    const people = [admin, reader];
    for (const person of people) {
      await setCanonicalUserProfileAvatar(person.id, PNG_BYTES, "image/png");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:ingress-${person.id}` },
        {
          sessionId: `ingress-${person.id}`,
          updatedAt: Date.now(),
          label: person.id,
          spawnedCwd: state.workspaceDir,
          createdActor: { type: "human", source: "profile", id: person.id },
          visibility: "draft",
        },
      );
    }
    const trustedProxy = {
      userHeader: "cf-access-authenticated-user-email",
      requiredHeaders: ["cf-access-jwt-assertion"],
    };
    auth = { mode: "trusted-proxy", trustedProxy, allowTailscale: false };
    config = {
      ...config,
      gateway: {
        ...config.gateway,
        auth: { mode: "trusted-proxy", trustedProxy },
        roles: {
          default: "reader",
          definitions: {
            admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
            policy: {
              scopes: ["operator.admin"],
              agents: "*",
              sessions: { others: "write" },
              accessPolicyPlugin: "unavailable-policy-fixture",
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config, config);
    projection?.dispose();
    projection = await createSessionRowProjection({ cfg: config, modelCatalog: [] });
    let adminMediaTicket: string | undefined;
    for (const person of people) {
      for (const full of [false, true]) {
        const ceiling = full ? ["operator.admin"] : [...SCOPES];
        const binding = await factory.bindPrincipal({
          ...openOptions,
          audienceId: `${person.id}-${full}`,
          principal: { kind: "person", profileId: person.id },
          operatorScopeCeiling: ceiling,
        });
        try {
          const expectedScopes = person.id === admin.id ? ceiling : ["operator.read"];
          expect(await binding.request("users.self", {})).toMatchObject({
            profile: { id: person.id },
          });
          const listed = await binding.request<{ sessions: Array<{ key: string }> }>(
            "sessions.list",
            {
              source: "sidebar",
              rowMode: "compact",
              limit: 20,
            },
          );
          expect(listed.sessions.map((session) => session.key)).toContain(
            `agent:main:ingress-${person.id}`,
          );
          if (person.id === reader.id) {
            expect(listed.sessions.map((session) => session.key)).not.toContain(
              `agent:main:ingress-${admin.id}`,
            );
          }
          if (person.id === admin.id && full) {
            expect(await binding.request("exec.approvals.get", {})).toHaveProperty(
              "resolvedDefaults",
            );
          } else {
            await expect(binding.request("exec.approvals.get", {})).rejects.toThrow(
              "operator.admin",
            );
          }
          if (person.id === reader.id) {
            await expect(
              binding.request("voicewake.set", { triggers: ["denied"] }),
            ).rejects.toThrow("operator.write");
          }
          const ui = await binding.openControlUi({
            publicOrigin: PUBLIC_ORIGIN,
            sandboxOrigin: SANDBOX_ORIGIN,
            frameAncestors: FRAME_ANCESTORS,
          });
          await usePeer(await openRemote(ui), async (peer) => {
            const identity = loadOrCreateDeviceIdentity({
              identityKey: `synthetic-person-${person.id}-${full}`,
            });
            expectHello(
              await connect(peer, { identity, profileId: person.id }),
              "remote-ingress",
              expectedScopes,
            );
            expect(await request(peer, "users.self", {})).toMatchObject({
              ok: true,
              payload: { profile: { id: person.id } },
            });
            expect(await request(peer, "exec.approvals.get", {})).toMatchObject({
              ok: person.id === admin.id && full,
            });
          });
          if (person.id === admin.id && full) {
            const metadata = await readRemote(`${assistantMediaPath}&meta=1`, ui);
            expect(metadata.status).toBe(200);
            adminMediaTicket = ((await metadata.json()) as { mediaTicket: string }).mediaTicket;
          } else if (person.id === reader.id) {
            expect(adminMediaTicket).toBeDefined();
            const replay = await readRemote(
              `${assistantMediaPath}&mediaTicket=${encodeURIComponent(adminMediaTicket!)}`,
              ui,
            );
            expect(replay.status).toBe(404);
            await replay.body?.cancel();
          }
          const avatar = await readRemote(`/claw/api/users/${person.id}/avatar`, ui);
          expect(avatar.status).toBe(200);
          await avatar.body?.cancel();
          const ownIcon = await readRemote(
            `/claw/__openclaw__/workspace-icon/${encodeURIComponent(`agent:main:ingress-${person.id}`)}`,
            ui,
          );
          expect(ownIcon.status).toBe(full && person.id === admin.id ? 200 : 403);
          await ownIcon.body?.cancel();
        } finally {
          await binding.close();
        }
      }
    }
    for (const profileId of ["missing-ingress-person", "gateway-owner"]) {
      await expect(
        factory.bindPrincipal({
          ...openOptions,
          principal: { kind: "person", profileId },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    const policyPerson = await ensureCanonicalUserProfileForEmail("policy@ingress.example.test");
    await setCanonicalUserProfileRole(policyPerson.id, "policy", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    await expect(
      factory.bindPrincipal({
        ...openOptions,
        principal: { kind: "person", profileId: policyPerson.id },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const change of ["role", "merge", "grant", "assert"] as const) {
      const subject = await ensureCanonicalUserProfileForEmail(`${change}@ingress.example.test`);
      await setCanonicalUserProfileRole(subject.id, "admin", {
        onCommitted: invalidateOperatorRolePolicy,
      });
      const grant = new AbortController();
      let grantCurrent = true;
      const binding = await factory.bindPrincipal({
        ...openOptions,
        principal: { kind: "person", profileId: subject.id },
        operatorScopeCeiling: ["operator.admin"],
        signal: grant.signal,
        assertCurrent: () => {
          grant.signal.throwIfAborted();
          if (!grantCurrent) {
            throw new Error("synthetic grant revoked by current assertion");
          }
        },
      });
      const ui = await binding.openControlUi({
        publicOrigin: PUBLIC_ORIGIN,
        sandboxOrigin: SANDBOX_ORIGIN,
        frameAncestors: FRAME_ANCESTORS,
      });
      try {
        const peer = await openRemote(ui);
        const identity = loadOrCreateDeviceIdentity({
          identityKey: `synthetic-retained-${change}`,
        });
        expectHello(await connect(peer, { identity, profileId: subject.id }), "remote-ingress", [
          "operator.admin",
        ]);
        heldMutation = { entered: createDeferred(), release: createDeferred(), remaining: 2 };
        heldRead = { entered: createDeferred(), release: createDeferred() };
        const pendingHttp = readRemote("/claw/control-ui-config.json?held=1", ui);
        const rejectedHttp = pendingHttp.catch((error: unknown) => error);
        const pendingWs = request(peer, "users.setDisplayName", {
          profileId: subject.id,
          displayName: "Must not be published",
        });
        const rejectedWs = pendingWs.catch((error: unknown) => error);
        const pending = binding.request("users.setDisplayName", {
          profileId: subject.id,
          displayName: "Must not be published",
        });
        const rejected = pending.catch((error: unknown) => error);
        await awaitGateBeforeSettlement(
          heldMutation.entered.promise,
          pending,
          "Mutation settled before reaching its held effect",
        );
        await awaitGateBeforeSettlement(
          heldRead.entered.promise,
          pendingHttp,
          "HTTP response settled before the held read",
        );
        if (change === "role") {
          await setCanonicalUserProfileRole(subject.id, "reader", {
            onCommitted: invalidateOperatorRolePolicy,
          });
        } else if (change === "merge") {
          await mergeCanonicalUserProfiles(subject.id, reader.id);
        } else if (change === "grant") {
          grant.abort(new Error("synthetic grant revoked"));
        } else {
          grantCurrent = false;
          expect(grant.signal.aborted).toBe(false);
        }
        heldMutation.release.resolve(undefined);
        heldRead.release.resolve(undefined);
        heldMutation = undefined;
        heldRead = undefined;
        expect(await rejected).toBeInstanceOf(Error);
        expect(await rejectedWs).toBeInstanceOf(Error);
        expect(await rejectedHttp).toBeInstanceOf(Error);
        await peer.close();
        const current = await ensureCanonicalUserProfileForEmail(`${change}@ingress.example.test`);
        expect(current.displayName).not.toBe("Must not be published");
        await expect(binding.request("voicewake.get", {})).rejects.toThrow();
        await expect(readRemote("/claw/control-ui-config.json", ui)).rejects.toThrow();
        await expect(openRemote(ui)).rejects.toThrow();
      } finally {
        heldMutation?.release.resolve(undefined);
        heldRead?.release.resolve(undefined);
        heldMutation = undefined;
        heldRead = undefined;
        await binding.close();
      }
    }
  });

  it("refuses an unauthenticated host", async () => {
    await ingress!.close();
    auth = { mode: "none", allowTailscale: false };
    config = {
      ...config,
      gateway: { ...config.gateway, roles: undefined, auth: { mode: "none" } },
    };
    setRuntimeConfigSnapshot(config, config);
    await expect(factory.open(openOptions)).rejects.toMatchObject({
      name: GatewayControlUiIngressError.name,
      code: "unsupported-auth",
      message: expect.stringContaining("token or password"),
    });
  });
});
