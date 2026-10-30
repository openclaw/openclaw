import { EventEmitter, once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams, HelloOk } from "../../../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as systemPresence from "../../../infra/system-presence.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveGatewayAuth } from "../../auth-resolve.js";
import type { HealthSummary } from "../../health/types.js";
import { startGatewayTailscaleExposure } from "../../server-tailscale.js";
import { prepareTailscalePublishedOrigin } from "../../tailscale-published-origin.js";
import { getHealthCache } from "../health-state.js";
import type { GatewayWsClient } from "../ws-types.js";

// Hello update-scope tests cover authenticated role/scope and recovery ownership projection.

const {
  buildGatewaySnapshotMock,
  emitGatewayAuthSecurityEventMock,
  getSessionRowProjectionMock,
  listControlUiPluginTabsMock,
  listControlUiPluginWidgetKindsMock,
} = vi.hoisted(() => ({
  emitGatewayAuthSecurityEventMock: vi.fn(),
  getSessionRowProjectionMock: vi.fn(),
  listControlUiPluginTabsMock: vi.fn((_scopes: readonly string[]) => []),
  listControlUiPluginWidgetKindsMock: vi.fn((_scopes: readonly string[]) => []),
  buildGatewaySnapshotMock: vi.fn((opts?: { includeUpdateDetails?: boolean }) => {
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    };
    return {
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 1,
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "per-sender",
      },
      updateAvailable: opts?.includeUpdateDetails
        ? {
            ...updateAvailable,
            currentSha: "1111111111111111111111111111111111111111",
            upstreamRef: "origin/main",
            upstreamSha: "2222222222222222222222222222222222222222",
            commitsBehind: 1,
            commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
          }
        : updateAvailable,
      ...(opts?.includeUpdateDetails
        ? {
            updateSchedule: {
              channel: "dev",
              autoEnabled: true,
              install: { kind: "git" },
            },
          }
        : {}),
    };
  }),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));

vi.mock("../../session-row-projection-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../session-row-projection-access.js")>()),
  getSessionRowProjection: getSessionRowProjectionMock,
}));

vi.mock("../../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: vi.fn(() => false),
}));

vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiLinkReaders: vi.fn(() => []),
  listControlUiPluginTabs: listControlUiPluginTabsMock,
  listControlUiPluginWidgetKinds: listControlUiPluginWidgetKindsMock,
}));

vi.mock("./connect-auth-security.js", () => ({
  emitGatewayAuthSecurityEvent: emitGatewayAuthSecurityEventMock,
}));

vi.mock("../../../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../version.js")>()),
  resolveRuntimeServiceBuildId: () => "build-a",
}));

const tailscaleClaim = vi.hoisted(() => vi.fn());
vi.mock("../../../infra/tailscale.js", () => ({
  claimTailscaleRoute: tailscaleClaim,
  getTailnetHostnameAfterServe: async () => "gateway.tailnet.ts.net",
  getTailnetHostname: async () => null,
}));

import { sendGatewayHello } from "./connect-hello.js";

function makeContext(
  role: "operator" | "node",
  scopes: string[],
  client?: Pick<GatewayWsClient, "internal" | "preparedSessionProfile">,
) {
  const connectParams: ConnectParams = {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
    role,
    scopes,
  };
  return {
    handler: {
      socket: new EventEmitter(),
      isClosed: vi.fn(() => false),
      getClient: () => client ?? null,
      connId: `conn-${role}`,
      bootId: "gateway-boot-a",
      gatewayMethods: [],
      events: [],
      buildRequestContext: () => ({ nodeRegistry: { get: () => undefined } }),
      refreshHealthSnapshot: vi.fn(async () => ({})),
      close: vi.fn(),
      advanceHandshakePhase: vi.fn(),
      setCloseCause: vi.fn(),
      logGateway: { warn: vi.fn() },
      logHealth: { error: vi.fn() },
    },
    frame: { id: `hello-${role}` },
    connectParams,
    configSnapshot: {},
    sendFrame: vi.fn(async () => undefined),
    onHelloDelivered: vi.fn(),
    pendingNodePairingCleanup: {},
    releasePendingNodePairingCleanup: vi.fn(async () => undefined),
  };
}

function makeState(role: "operator" | "node", scopes: string[]) {
  return {
    resolvedAuth: { mode: "none" },
    role,
    scopes,
    device: null,
    hasTokenAuth: false,
    hasPasswordAuth: false,
    authResult: { ok: true, method: "none" },
    authMethod: "none",
    issuedBootstrapProfile: null,
    handoffBootstrapProfile: null,
    deviceToken: null,
    bootstrapDeviceTokens: [],
  };
}

function helloPayload(context: ReturnType<typeof makeContext>) {
  const response = context.sendFrame.mock.calls.at(0)?.at(0) as { payload?: HelloOk } | undefined;
  return response?.payload;
}

function helloSnapshot(context: ReturnType<typeof makeContext>) {
  return helloPayload(context)?.snapshot;
}

function expectRedactedHelloSnapshot(context: ReturnType<typeof makeContext>) {
  expect(helloSnapshot(context)).toEqual(
    expect.objectContaining({
      updateAvailable: {
        currentVersion: "2026.8.7",
        latestVersion: "2026.8.8",
        channel: "dev",
      },
    }),
  );
  expect(helloSnapshot(context)?.updateSchedule).toBeUndefined();
}

describe("sendGatewayHello update detail scope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getSessionRowProjectionMock.mockReset();
    prepareTailscalePublishedOrigin({ origin: "https://reset.test", mode: "serve" })();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHealthCache).mockReturnValue(null);
  });

  it.each([
    { origin: "https://gateway.example.test", local: false, expected: true },
    { origin: "http://127.0.0.1:18789", local: true, expected: true },
    { origin: "http://127.0.0.1:18789", local: false, expected: false },
  ])(
    "advertises browser sign-in only for a secure served return: %j",
    async ({ origin, local, expected }) => {
      const context = {
        ...makeContext("operator", ["operator.read"]),
        browserOrigin: { origin, requestHost: new URL(origin).host, isLocalClient: local },
      };
      const gatewayMethods = ["health", "mcp.authLogin"];
      await sendGatewayHello(
        { ...context, handler: { ...context.handler, gatewayMethods } } as never,
        makeState("operator", ["operator.read"]) as never,
        {},
      );
      expect(helloPayload(context)?.features.methods).toEqual(
        expected ? gatewayMethods : ["health"],
      );
    },
  );

  it.each([
    { caps: [], mode: "full" },
    { caps: [GATEWAY_CLIENT_CAPS.HEALTH_SUMMARY], mode: "summary" },
    { caps: [GATEWAY_CLIENT_CAPS.HELLO_HEALTH_ON_DEMAND], mode: "empty" },
    {
      caps: [GATEWAY_CLIENT_CAPS.HELLO_HEALTH_ON_DEMAND, GATEWAY_CLIENT_CAPS.HEALTH_SUMMARY],
      mode: "empty",
    },
  ])("negotiates $mode cached health in hello", async ({ caps, mode }) => {
    const summary = {
      ok: true as const,
      ts: 123,
      durationMs: 1,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
    };
    const health: HealthSummary = {
      ...summary,
      agents: [],
      sessions: { path: "", count: 5000, recent: [] },
    };
    vi.mocked(getHealthCache).mockReturnValue(health);
    const context = makeContext("operator", ["operator.read"]);
    context.connectParams = {
      ...context.connectParams,
      caps,
    };

    await sendGatewayHello(context as never, makeState("operator", ["operator.read"]) as never, {});

    expect(helloSnapshot(context)).toMatchObject({
      presence: [],
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 1,
    });
    expect(helloSnapshot(context)?.health).toEqual(
      mode === "empty" ? {} : mode === "summary" ? summary : health,
    );
  });

  it.each([undefined, []])(
    "sends hello without membership reads for idle presence (%j)",
    async (watchedSessions) => {
      vi.spyOn(systemPresence, "listSystemPresence").mockReturnValue([
        { text: "idle peer", ts: 1, watchedSessions },
      ]);
      const projection = {
        needsMembershipPreparation: vi.fn(() => true),
        prepareMembership: vi.fn(async () => {
          throw new Error("unexpected membership read");
        }),
      };
      getSessionRowProjectionMock.mockReturnValue(projection);
      const context = makeContext("operator", ["operator.read"]);

      await sendGatewayHello(
        context as never,
        makeState("operator", ["operator.read"]) as never,
        {},
      );

      expect(projection.needsMembershipPreparation).not.toHaveBeenCalled();
      expect(projection.prepareMembership).not.toHaveBeenCalled();
      expect(context.sendFrame).toHaveBeenCalledOnce();
    },
  );

  it("sends hello while watched-session membership preparation is pending", async () => {
    vi.spyOn(systemPresence, "listSystemPresence").mockReturnValue([
      { text: "watching peer", ts: 1, watchedSessions: ["agent:main:watched"] },
    ]);
    const projection = {
      needsMembershipPreparation: vi.fn(() => true),
      prepareMembership: vi.fn(() => new Promise<void>(() => {})),
    };
    getSessionRowProjectionMock.mockReturnValue(projection);
    const context = makeContext("operator", ["operator.read"]);

    await sendGatewayHello(context as never, makeState("operator", ["operator.read"]) as never, {});

    expect(context.sendFrame).toHaveBeenCalledOnce();
    expect(projection.prepareMembership).not.toHaveBeenCalled();
  });

  it.each(["write", "suggest", "view", "none", undefined] as const)(
    "projects the current operator session cap %s only when configured",
    async (sessionCap) => {
      const context = makeContext("operator", ["operator.write"], {
        internal: { operatorRoleActor: { kind: "operator", profileId: "profile-riley" } },
        preparedSessionProfile: {
          profileId: "profile-riley",
          aliases: new Set(["profile-riley"]),
          role: "collaborator",
        },
      });
      if (sessionCap !== undefined) {
        context.configSnapshot = {
          gateway: {
            roles: {
              default: "collaborator",
              definitions: {
                collaborator: {
                  sessions: { others: sessionCap },
                  agents: ["main"],
                  scopes: ["operator.write"],
                },
              },
            },
          },
        } satisfies OpenClawConfig;
      }

      await sendGatewayHello(
        context as never,
        makeState("operator", ["operator.write"]) as never,
        {},
      );

      const auth = helloPayload(context)?.auth;
      if (sessionCap === undefined) {
        expect(auth).not.toHaveProperty("sessionCap");
      } else {
        expect(auth?.sessionCap).toBe(sessionCap);
      }
    },
  );

  it.each([
    { mode: "trusted-proxy", tailscale: "off", expected: true },
    { mode: "trusted-proxy", tailscale: "serve", allowTailscale: true, expected: true },
    { mode: "token", tailscale: "serve", expected: true },
    { mode: "token", tailscale: "serve", publicOrigin: undefined, expected: true },
    { mode: "password", tailscale: "serve", allowTailscale: true, expected: true },
    { mode: "password", tailscale: "serve", expected: false },
    { mode: "token", tailscale: "serve", allowTailscale: false, expected: false },
    { mode: "token", tailscale: "off", expected: false },
    { mode: "password", tailscale: "funnel", allowTailscale: true, expected: false },
    { mode: "none", tailscale: "off", expected: false },
    { mode: "none", tailscale: "serve", expected: false },
  ] as const)(
    "advertises the personal dashboard for resolved $mode auth with $tailscale",
    async ({ mode, tailscale, expected, ...options }) => {
      if (tailscale !== "off") {
        prepareTailscalePublishedOrigin({
          origin: "https://gateway.tailnet.ts.net",
          mode: tailscale,
        });
      }
      const config: OpenClawConfig = {
        gateway: {
          publicOrigin:
            "publicOrigin" in options ? options.publicOrigin : "https://team.example.test",
          auth: {
            mode,
            ...("allowTailscale" in options ? { allowTailscale: options.allowTailscale } : {}),
          },
          tailscale: { mode: tailscale },
          controlUi: { basePath: " /team/ " },
        },
      };
      const context = makeContext("operator", ["operator.read"]);
      context.configSnapshot = config;
      const state = {
        ...makeState("operator", ["operator.read"]),
        resolvedAuth: resolveGatewayAuth({
          authConfig: config.gateway?.auth,
          tailscaleMode: tailscale,
          env: {},
        }),
      };
      await sendGatewayHello(context as never, state as never, {});
      expect(helloSnapshot(context)?.controlUiIdentityUrl).toBe(
        expected
          ? mode === "trusted-proxy"
            ? "https://team.example.test/team/"
            : "https://gateway.tailnet.ts.net/team/"
          : undefined,
      );
      prepareTailscalePublishedOrigin({ origin: "https://reset.test", mode: "serve" })();
      if (expected && mode !== "trusted-proxy") {
        expect(context.handler.close).toHaveBeenCalledWith(1012, expect.any(String));
      } else {
        expect(context.handler.close).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["before hello delivery", "after hello delivery", "during hello delivery"] as const)(
    "releases only live announcement owners when withdrawn %s",
    async (phase) => {
      const clear = prepareTailscalePublishedOrigin({
        origin: "https://gateway.tailnet.ts.net",
        mode: "serve",
      });
      const context = makeContext("operator", ["operator.read"]);
      const state = {
        ...makeState("operator", ["operator.read"]),
        resolvedAuth: { mode: "token", allowTailscale: true },
      };
      if (phase === "before hello delivery") {
        context.handler.isClosed.mockReturnValue(true);
        context.handler.socket.emit("close");
      }
      if (phase === "during hello delivery") {
        context.sendFrame.mockImplementation(async () => {
          clear();
        });
      }
      await sendGatewayHello(context as never, state as never, {});
      if (phase !== "during hello delivery") {
        if (phase === "after hello delivery") {
          context.handler.socket.emit("close");
        }
        clear();
        expect(context.handler.close).not.toHaveBeenCalled();
      } else {
        expect(context.handler.close).toHaveBeenCalledWith(1012, expect.any(String));
      }
    },
  );

  it.each(["exit", "cleanup", "replacement"] as const)(
    "retires an announced Serve connection on route %s and renews its hello",
    async (withdrawal) => {
      const gatewayMethods = ["health", "config.get"];
      const exited = createDeferredCore();
      tailscaleClaim.mockResolvedValueOnce({
        exited: exited.promise,
        isActive: () => true,
        stop: vi.fn(),
      });
      tailscaleClaim.mockRejectedValue(new Error("Tailscale daemon unavailable"));
      const cleanup = await startGatewayTailscaleExposure({
        tailscaleMode: "serve",
        port: 18789,
        backend: { host: "127.0.0.1", port: 19000 },
        logTailscale: { info: vi.fn(), warn: vi.fn() },
      });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing WebSocket listener");
      }
      const clients: WebSocket[] = [];
      const connect = async () => {
        const accepted = once(server, "connection");
        const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
        clients.push(client);
        await once(client, "open");
        const [socket] = (await accepted) as [WebSocket];
        const context = makeContext("operator", ["operator.read"]);
        const state = {
          ...makeState("operator", ["operator.read"]),
          resolvedAuth: { mode: "token", allowTailscale: true },
        };
        const response = once(client, "message");
        await sendGatewayHello(
          {
            ...context,
            handler: {
              ...context.handler,
              gatewayMethods,
              socket,
              close: (code?: number, reason?: string) => socket.close(code, reason),
            },
            sendFrame: (frame: unknown) =>
              new Promise<void>((resolve, reject) => {
                socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
              }),
          } as never,
          state as never,
          {},
        );
        const [frame] = await response;
        const hello = JSON.parse(String(frame)) as { payload: HelloOk };
        return { client, hello: hello.payload, close: vi.fn() };
      };
      try {
        const original = await connect();
        expect(original.hello.features.methods).toEqual(gatewayMethods);
        expect(original.hello.snapshot.controlUiIdentityUrl).toBe(
          "https://gateway.tailnet.ts.net/",
        );
        original.client.on("close", original.close);
        if (withdrawal === "exit") {
          exited.resolve();
        } else if (withdrawal === "cleanup") {
          await cleanup?.();
        } else {
          prepareTailscalePublishedOrigin({
            origin: "https://replacement.tailnet.ts.net",
            mode: "serve",
          });
          // A late old cleanup must not withdraw the replacement's announcement.
          await cleanup?.();
        }
        await vi.waitFor(() =>
          expect(original.close).toHaveBeenCalledWith(1012, expect.anything()),
        );
        const renewed = await connect();
        expect(renewed.hello.features.methods).toEqual(gatewayMethods);
        expect(renewed.hello.snapshot.controlUiIdentityUrl).toBe(
          withdrawal === "replacement" ? "https://replacement.tailnet.ts.net/" : undefined,
        );
        expect(renewed.client.readyState).toBe(WebSocket.OPEN);
      } finally {
        for (const client of clients) {
          client.terminate();
        }
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await cleanup?.();
      }
    },
  );

  it.each([
    { role: "node", origin: "https://team.example.test", enabled: true },
    { role: "operator", origin: undefined, enabled: true },
    { role: "operator", origin: "http://127.0.0.1:18789", enabled: true },
    { role: "operator", origin: "https://team.example.test", enabled: false },
  ] as const)(
    "does not advertise unavailable browser identity ($role, $origin, $enabled)",
    async (testCase) => {
      const clear = prepareTailscalePublishedOrigin({
        origin: "https://gateway.tailnet.ts.net",
        mode: "serve",
      });
      const context = makeContext(testCase.role, ["operator.read"]);
      context.configSnapshot = {
        gateway: { publicOrigin: testCase.origin, controlUi: { enabled: testCase.enabled } },
      };
      const state = {
        ...makeState(testCase.role, ["operator.read"]),
        resolvedAuth: { mode: "trusted-proxy", allowTailscale: false },
      };
      await sendGatewayHello(context as never, state as never, {});
      expect(helloSnapshot(context)).not.toHaveProperty("controlUiIdentityUrl");
      clear();
      expect(context.handler.close).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "pairing-only operator", role: "operator" as const, scopes: ["operator.pairing"] },
    { label: "node", role: "node" as const, scopes: ["operator.read"] },
  ])("omits update details for a $label", async ({ role, scopes }) => {
    const context = makeContext(role, scopes);
    await sendGatewayHello(context as never, makeState(role, scopes) as never, {});

    expect(buildGatewaySnapshotMock).toHaveBeenCalledWith({
      client: null,
      includeSensitive: false,
      includeUpdateDetails: false,
    });
    expectRedactedHelloSnapshot(context);
    expect(helloPayload(context)?.features.capabilities).toContain("node-permission-errors");
    expect(helloPayload(context)?.features.capabilities).toContain("agent-session-id-create-v1");
  });

  it.each([
    { label: "default bundled UI", controlUi: undefined, source: "bundled", browserFocus: true },
    {
      label: "enabled bundled UI",
      controlUi: { enabled: true },
      source: "bundled",
      browserFocus: true,
    },
    {
      label: "disabled bundled UI",
      controlUi: { enabled: false },
      source: "bundled",
      browserFocus: false,
    },
    {
      label: "configured UI",
      controlUi: { root: "/custom/ui" },
      source: "configured",
      browserFocus: false,
    },
  ])(
    "reports Gateway build identity and browser focus support for $label",
    async ({ controlUi, source, browserFocus }) => {
      const context = makeContext("operator", ["operator.read"]);
      context.configSnapshot = { gateway: { controlUi } };

      await sendGatewayHello(
        context as never,
        makeState("operator", ["operator.read"]) as never,
        {},
      );

      expect(helloPayload(context)?.server.buildId).toBe("build-a");
      expect(helloPayload(context)?.server.controlUiBuildSource).toBe(source);
      expect(
        helloPayload(context)?.features.capabilities?.includes("control-ui-browser-focus"),
      ).toBe(browserFocus);
    },
  );

  it.each([
    [
      { publicOrigin: "https://gateway.example.test", controlUi: { basePath: " /remote/// " } },
      "https://gateway.example.test/remote",
    ],
    [{ publicOrigin: "https://gateway.example.test", controlUi: { enabled: false } }, undefined],
    [{}, undefined],
  ])("advertises the configured Control UI address: %j", async (gateway, controlUiUrl) => {
    const context = makeContext("operator", ["operator.read"]);
    context.configSnapshot = { gateway };
    await sendGatewayHello(context as never, makeState("operator", ["operator.read"]) as never, {});
    expect(helloPayload(context)?.controlUiUrl).toBe(controlUiUrl);
    if (controlUiUrl === undefined) {
      expect(helloPayload(context)).not.toHaveProperty("controlUiUrl");
    }
  });

  it("keeps hello projection and telemetry at effective scopes", async () => {
    const state = {
      ...makeState("operator", ["operator.pairing"]),
      deviceToken: {
        token: "paired-token",
        role: "operator",
        scopes: ["operator.read", "operator.admin"],
        createdAtMs: 1,
      },
    };

    const context = makeContext("operator", ["operator.pairing"]);
    await sendGatewayHello(context as never, state as never, {}, "owner-profile");

    expect(buildGatewaySnapshotMock).toHaveBeenCalledWith({
      client: null,
      includeSensitive: false,
      includeUpdateDetails: false,
    });
    expectRedactedHelloSnapshot(context);
    expect(helloPayload(context)?.auth).toEqual({
      method: "none",
      role: "operator",
      scopes: ["operator.pairing"],
      roleAllowsAdmin: true,
      recoveryMigrationAllowed: true,
      recoveryScope: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      deviceToken: "paired-token",
      issuedAtMs: 1,
    });
    expect(listControlUiPluginTabsMock).toHaveBeenCalledWith(["operator.pairing"], {
      requireGatewayAuthGrant: false,
    });
    expect(listControlUiPluginWidgetKindsMock).toHaveBeenCalledWith(["operator.pairing"]);
    expect(emitGatewayAuthSecurityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "operator", scopes: ["operator.pairing"] }),
    );
  });

  it("keeps recovery scope owned by the canonical authenticated principal", async () => {
    const sendFor = async (principal: string, token: string, generation: string) => {
      const context = makeContext("operator", ["operator.read"]);
      const state = {
        ...makeState("operator", ["operator.read"]),
        authResult: { ok: true, method: "trusted-proxy", user: `${principal}@example.test` },
        device: { id: "device-a" },
        deviceToken: {
          token,
          role: "operator",
          scopes: ["operator.read"],
          createdAtMs: 1,
        },
        sessionSharedGatewaySessionGeneration: generation,
      };
      await sendGatewayHello(context as never, state as never, {}, principal);
      const auth = helloPayload(context)?.auth;
      expect(auth?.recoveryMigrationAllowed).toBeUndefined();
      return auth?.recoveryScope;
    };

    const alice = await sendFor("profile-alice", "device-token-a", "shared-generation-a");
    const rotated = await sendFor("profile-alice", "device-token-b", "shared-generation-b");
    const bob = await sendFor("profile-bob", "device-token-a", "shared-generation-a");

    expect(rotated).toBe(alice);
    expect(bob).not.toBe(alice);
    for (const scope of [alice, rotated, bob]) {
      expect(scope).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(scope).not.toContain("profile-");
      expect(scope).not.toContain("device-token-");
    }
  });
});
