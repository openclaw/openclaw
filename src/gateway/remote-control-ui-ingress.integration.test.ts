import { on, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { saveMediaBuffer } from "../media/store.js";
import type {
  GatewayControlUiIngressFactoryV2,
  GatewayControlUiIngressV2,
} from "../plugins/gateway-ingress.types.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { uploadUserBackground } from "../state/user-background.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileAvatar,
} from "../state/user-profile-writes.js";
import { withEnv } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createSandboxHostHttpRequestHandler } from "./mcp-app-sandbox-http.js";
import {
  connect,
  request,
  expectHello,
  PNG_BYTES,
  usePeer,
  expectReadWriteWithoutAdmin,
  type IngressFrame,
  type Peer,
  TRUSTED_PROXY,
  TEAM_ROLES,
} from "./remote-control-ui-ingress.integration.test-support.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import {
  expectMcpRelayPrincipalAuthority,
  createIngressPerson,
  setIngressRole,
} from "./remote-control-ui-mcp-relay.test-support.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { getControlUiModule } from "./server-http-modules.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { usersHandlers } from "./server-methods/users.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import { createGatewayWsTestRequestContext } from "./server/ws-connection.test-helpers.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

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
const TOKEN_AUTH = { mode: "token", token: SHARED_TOKEN, allowTailscale: false } as const;
const SCOPES = ["operator.read", "operator.write"] as const;
const OWNER_SESSION_KEY = "agent:main:ingress-owner-chat";

function heldReadBarrier() {
  return { entered: createDeferred(), release: createDeferred() };
}
function heldMutationBarrier(count: number) {
  return { ...heldReadBarrier(), remaining: count, unsettled: count, settled: createDeferred() };
}

describe("remote Control UI ingress production composition", () => {
  let state: OpenClawTestState;
  let ingress: GatewayControlUiIngressV2 | undefined;
  let factory: GatewayControlUiIngressFactoryV2;
  let config: OpenClawConfig;
  let auth: ResolvedGatewayAuth;
  let gatewayContext: GatewayRequestContext;
  let projection: SessionRowProjection | undefined;
  let backgroundPath: string;
  let assistantMediaPath: string;
  let heldMutation: ReturnType<typeof heldMutationBarrier> | undefined;
  let heldRead: ReturnType<typeof heldReadBarrier> | undefined;
  const extraHandlers: GatewayRequestHandlers = {
    "users.setDisplayName": async (options) => {
      const held = heldMutation;
      if (held) {
        held.remaining -= 1;
        if (held.remaining === 0) {
          held.entered.resolve(undefined);
        }
        await held.release.promise;
      }
      try {
        await usersHandlers["users.setDisplayName"]!(options);
      } finally {
        if (held && --held.unsettled === 0) {
          held.settled.resolve(undefined);
        }
      }
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
  const principalOptions = {
    audienceId: "synthetic-integration-grant",
    principal: { kind: "owner" as const },
    operatorScopeCeiling: SCOPES,
    signal: grantLifetime.signal,
    assertCurrent: () => grantLifetime.signal.throwIfAborted(),
  };

  const presentationOptions = {
    publicOrigin: PUBLIC_ORIGIN,
    sandboxOrigin: SANDBOX_ORIGIN,
    frameAncestors: FRAME_ANCESTORS,
  };
  const openOptions = { ...principalOptions, ...presentationOptions };

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
    assert(background.status === "ok" && background.asset, "Missing fixture background");
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
    auth = TOKEN_AUTH;
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
    gatewayContext = requestContext as never;
    const preauthConnectionBudget = withEnv(
      { OPENCLAW_MAX_PREAUTH_CONNECTIONS_PER_IP: "8" },
      createPreauthConnectionBudget,
    );
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
      buildRequestContext: () => gatewayContext,
    });
    // Keep source transformation outside the remote HTTP progress deadline.
    await getControlUiModule();
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
    assert(handle, "Missing ingress fixture");
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
        assert(!frame.done && frame.value.kind === "text", "Expected a Gateway JSON frame");
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
        assert(!frame.done, "Direct Gateway socket closed before its response");
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

  async function configure(nextConfig: OpenClawConfig, nextAuth: ResolvedGatewayAuth) {
    config = nextConfig;
    auth = nextAuth;
    setRuntimeConfigSnapshot(config, config);
    projection?.dispose();
    projection = await createSessionRowProjection({ cfg: config, modelCatalog: [] });
  }

  const configureAuth = (
    nextAuth: ResolvedGatewayAuth,
    roles?: NonNullable<OpenClawConfig["gateway"]>["roles"],
  ) => configure({ ...config, gateway: { ...config.gateway, roles, auth: nextAuth } }, nextAuth);

  async function expectStatus(response: Promise<Response>, status: number) {
    const result = await response;
    expect(result.status).toBe(status);
    await result.body?.cancel();
  }

  const personOptions = (profileId: string) => ({
    ...principalOptions,
    principal: { kind: "person" as const, profileId },
  });

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
    for (const pathname of [configPath, imagePaths[2]!]) {
      await expectStatus(fetch(`${directOrigin}${pathname}`), 401);
    }
    const metadata = await readRemote(`${assistantMediaPath}&meta=1`);
    expect(metadata.status).toBe(200);
    const media = (await metadata.json()) as { available: boolean; mediaTicket: string };
    expect(media).toMatchObject({ available: true, mediaTicket: expect.stringMatching(/^v1\./) });
    const ticketedPath = `${assistantMediaPath}&mediaTicket=${encodeURIComponent(media.mediaTicket)}`;
    const remoteMedia = await readRemote(ticketedPath);
    expect(remoteMedia.status).toBe(200);
    expect(await remoteMedia.text()).toBe("Ingress chat media\n");
    await expectStatus(fetch(`${directOrigin}${ticketedPath}`), 404);
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
        if (scopes?.length === SCOPES.length) {
          await expectReadWriteWithoutAdmin(peer, "credential-free browser");
        }
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
      assert(adminClient, "Missing authenticated administrator connection");
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
      expect(list).toMatchObject({ ok: true, payload: { pending: [] } });
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
    expect(response.headers.get("origin-agent-cluster")).toBe("?1");
    expect(response.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${PUBLIC_ORIGIN} ${FRAME_ANCESTORS.join(" ")}`,
    );
    await response.body?.cancel();
  });

  it("rejects invalid devices, reusable credentials, roles and scopes at WebSocket admission", async () => {
    const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-rejected-browser" });
    const cases = [
      { change: { identity: undefined }, message: "signed device identity" },
      { change: { tamperSignature: true }, message: "signature" },
      { change: { role: "node" }, message: "operator role" },
      ...[
        { token: "synthetic-credential" },
        { password: "synthetic-credential" },
        { deviceToken: "synthetic-credential" },
        { bootstrapToken: "synthetic-credential" },
      ].map((credentials) => ({
        change: { auth: credentials },
        message: "credential-free signed device",
      })),
      ...[
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
        "operator.talk.secrets",
      ].map((scope) => ({ change: { scopes: [scope] }, message: "ceiling" })),
    ];
    for (const { change, message } of cases) {
      await usePeer(await openRemote(), async (peer) => {
        expect(await connect(peer, { identity, ...change })).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(message) },
        });
      });
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

  it("restricts Team HTTP assets and admits a reader under the current role", async () => {
    await ingress!.close();
    const admin = await createIngressPerson("admin", "admin", state.workspaceDir);
    const reader = await createIngressPerson("reader", "reader", state.workspaceDir);
    const people = [admin, reader];
    for (const person of people) {
      await setCanonicalUserProfileAvatar(person.id, PNG_BYTES, "image/png");
    }
    await configureAuth(
      { mode: "trusted-proxy", trustedProxy: TRUSTED_PROXY, allowTailscale: false },
      TEAM_ROLES,
    );
    let adminMediaTicket: string | undefined;
    for (const person of people) {
      const isAdmin = person.id === admin.id;
      const ceiling = isAdmin ? ["operator.admin"] : [...SCOPES];
      const binding = await factory.bindPrincipal({
        ...personOptions(person.id),
        audienceId: person.id,
        operatorScopeCeiling: ceiling,
      });
      try {
        const ui = await binding.openControlUi(presentationOptions);
        if (!isAdmin) {
          await usePeer(await openRemote(ui), async (peer) => {
            const identity = loadOrCreateDeviceIdentity({ identityKey: "synthetic-person-reader" });
            expectHello(await connect(peer, { identity, profileId: person.id }), "remote-ingress", [
              "operator.read",
            ]);
          });
        }
        if (isAdmin) {
          const metadata = await readRemote(`${assistantMediaPath}&meta=1`, ui);
          expect(metadata.status).toBe(200);
          adminMediaTicket = ((await metadata.json()) as { mediaTicket: string }).mediaTicket;
        } else if (person.id === reader.id) {
          expect(adminMediaTicket).toBeDefined();
          await expectStatus(
            readRemote(
              `${assistantMediaPath}&mediaTicket=${encodeURIComponent(adminMediaTicket!)}`,
              ui,
            ),
            404,
          );
        }
        await expectStatus(readRemote(`/claw/api/users/${person.id}/avatar`, ui), 200);
        // Session byte routes follow session visibility: each person reads the icon of the
        // draft they created, the reader role (sessions.others: none) cannot see the admin's
        // draft, and admin scope stays unfiltered.
        const iconPath = (owner: { id: string }) =>
          `/claw/__openclaw__/workspace-icon/${encodeURIComponent(`agent:main:ingress-${owner.id}`)}`;
        await expectStatus(readRemote(iconPath(person), ui), 200);
        await expectStatus(readRemote(iconPath(isAdmin ? reader : admin), ui), isAdmin ? 200 : 403);
      } finally {
        await binding.close();
      }
    }
    for (const profileId of ["missing-ingress-person", "gateway-owner"]) {
      await expect(factory.bindPrincipal(personOptions(profileId))).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const policyPerson = await ensureCanonicalUserProfileForEmail("policy@ingress.example.test");
    await setIngressRole(policyPerson.id, "policy");
    await expect(factory.bindPrincipal(personOptions(policyPerson.id))).rejects.toMatchObject({
      code: "forbidden",
    });
    for (const change of ["role", "merge", "grant"] as const) {
      const subject = await ensureCanonicalUserProfileForEmail(`${change}@ingress.example.test`);
      await setIngressRole(subject.id, "admin");
      const grant = new AbortController();
      const binding = await factory.bindPrincipal({
        ...personOptions(subject.id),
        signal: grant.signal,
      });
      try {
        expect(await binding.request("users.self", {})).toHaveProperty("profile.id", subject.id);
        if (change === "role") {
          await setIngressRole(subject.id, "reader");
        } else if (change === "merge") {
          await mergeCanonicalUserProfiles(subject.id, reader.id);
        } else {
          grant.abort();
        }
        await expect(binding.request("voicewake.get", {})).rejects.toThrow();
      } finally {
        await binding.close();
      }
    }
  });

  it("fences held HTTP, WebSocket and RPC work before effects and publication on grant revocation", async () => {
    const subject = { id: "gateway-owner" };
    await configureAuth(TOKEN_AUTH);
    const grant = new AbortController();
    let grantCurrent = true;
    const binding = await factory.bindPrincipal({
      ...principalOptions,
      principal: { kind: "owner" },
      operatorScopeCeiling: ["operator.admin"],
      signal: grant.signal,
      assertCurrent: () => {
        grant.signal.throwIfAborted();
        if (!grantCurrent) {
          throw new Error("synthetic grant revoked by current assertion");
        }
      },
    });
    const ui = await binding.openControlUi(presentationOptions);
    try {
      const peer = await openRemote(ui);
      const identity = loadOrCreateDeviceIdentity({
        identityKey: "synthetic-retained-assert",
      });
      expectHello(await connect(peer, { identity, profileId: subject.id }), "remote-ingress", [
        "operator.admin",
      ]);
      heldMutation = heldMutationBarrier(2);
      heldRead = heldReadBarrier();
      const pendingHttp = readRemote("/claw/control-ui-config.json?held=1", ui);
      const rejectedHttp = pendingHttp.catch((error: unknown) => error);
      const mutation = {
        profileId: subject.id,
        displayName: "Must not be published",
      };
      const pendingWs = request(peer, "users.setDisplayName", mutation);
      const rejectedWs = pendingWs.catch((error: unknown) => error);
      const pending = binding.request("users.setDisplayName", mutation);
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
      grantCurrent = false;
      expect(grant.signal.aborted).toBe(false);
      heldMutation.release.resolve(undefined);
      heldRead.release.resolve(undefined);
      await heldMutation.settled.promise;
      heldMutation = undefined;
      heldRead = undefined;
      expect(await rejected).toBeInstanceOf(Error);
      expect(await rejectedWs).toBeInstanceOf(Error);
      expect(await rejectedHttp).toBeInstanceOf(Error);
      await peer.close();
      const current = await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
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
  });

  it("shares real principal authority across MCP relay tools, UI, and grant revocation", () =>
    expectMcpRelayPrincipalAuthority({
      factory,
      state,
      context: gatewayContext,
      clients,
      openOptions,
      openRemote,
      config,
      sharedToken: SHARED_TOKEN,
      ownerSessionKey: OWNER_SESSION_KEY,
      configure,
    }));
});
