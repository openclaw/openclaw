import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams, HelloOk } from "../../../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveGatewayAuth } from "../../auth-resolve.js";
import type { HealthSummary } from "../../health/types.js";
import { prepareTailscalePublishedOrigin } from "../../tailscale-published-origin.js";
import { getHealthCache } from "../health-state.js";
import { createGatewaySnapshotFixture } from "../health-state.test-support.js";
import type { GatewayWsClient } from "../ws-types.js";

const {
  buildGatewaySnapshotMock,
  emitGatewayAuthSecurityEventMock,
  listControlUiPluginTabsMock,
  listControlUiPluginWidgetKindsMock,
} = vi.hoisted(() => ({
  emitGatewayAuthSecurityEventMock: vi.fn(),
  listControlUiPluginTabsMock: vi.fn((_scopes: readonly string[]) => []),
  listControlUiPluginWidgetKindsMock: vi.fn((_scopes: readonly string[]) => []),
  buildGatewaySnapshotMock: vi.fn((opts?: { includeUpdateDetails?: boolean }) => {
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    };
    return {
      ...createGatewaySnapshotFixture(),
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
  getSessionRowProjection: vi.fn(),
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

function sendHello(
  context: ReturnType<typeof makeContext>,
  state: unknown = makeState(
    context.connectParams.role === "node" ? "node" : "operator",
    context.connectParams.scopes ?? [],
  ),
  principal?: string,
) {
  return sendGatewayHello(context as never, state as never, {}, principal);
}

function expectRedactedHelloSnapshot(context: ReturnType<typeof makeContext>) {
  expect(helloSnapshot(context)?.updateAvailable).toEqual({
    currentVersion: "2026.8.7",
    latestVersion: "2026.8.8",
    channel: "dev",
  });
  expect(helloSnapshot(context)?.updateSchedule).toBeUndefined();
}

describe("sendGatewayHello update detail scope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
      await sendHello({ ...context, handler: { ...context.handler, gatewayMethods } });
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

    await sendHello(context);

    expect(helloSnapshot(context)?.health).toEqual(
      mode === "empty" ? {} : mode === "summary" ? summary : health,
    );
  });

  it.each(["write", "none", undefined] as const)(
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

      await sendHello(context);

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
    { mode: "token", tailscale: "serve", expected: true },
    { mode: "password", tailscale: "serve", allowTailscale: true, expected: true },
    { mode: "password", tailscale: "serve", expected: false },
    { mode: "token", tailscale: "serve", allowTailscale: false, expected: false },
    { mode: "token", tailscale: "off", expected: false },
    { mode: "password", tailscale: "funnel", allowTailscale: true, expected: false },
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
          publicOrigin: "https://team.example.test",
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
      await sendHello(context, state);
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

  it.each([
    "before hello delivery",
    "after hello delivery",
    "during hello delivery",
    "replacement",
  ] as const)("releases only live announcement owners when withdrawn %s", async (phase) => {
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
    await sendHello(context, state);
    if (phase === "replacement") {
      const replacement = prepareTailscalePublishedOrigin({
        origin: "https://replacement.tailnet.ts.net",
        mode: "serve",
      });
      clear();
      const renewed = makeContext("operator", ["operator.read"]);
      await sendHello(renewed, state);
      expect(helloSnapshot(renewed)?.controlUiIdentityUrl).toBe(
        "https://replacement.tailnet.ts.net/",
      );
      expect(context.handler.close).toHaveBeenCalledWith(1012, expect.any(String));
      replacement();
    } else if (phase !== "during hello delivery") {
      if (phase === "after hello delivery") {
        context.handler.socket.emit("close");
      }
      clear();
      expect(context.handler.close).not.toHaveBeenCalled();
    } else {
      expect(context.handler.close).toHaveBeenCalledWith(1012, expect.any(String));
    }
    if (phase !== "replacement") {
      const renewed = makeContext("operator", ["operator.read"]);
      await sendHello(renewed, state);
      expect(helloSnapshot(renewed)?.controlUiIdentityUrl).toBeUndefined();
    }
  });

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
      await sendHello(context, state);
      expect(helloSnapshot(context)).not.toHaveProperty("controlUiIdentityUrl");
      clear();
      expect(context.handler.close).not.toHaveBeenCalled();
    },
  );

  it("omits update details for a node", async () => {
    const context = makeContext("node", ["operator.read"]);
    await sendHello(context);
    expectRedactedHelloSnapshot(context);
  });

  it.each([
    [{}, "bundled", true, undefined],
    [
      { publicOrigin: "https://gateway.example.test", controlUi: { enabled: false } },
      "bundled",
      false,
      undefined,
    ],
    [
      {
        publicOrigin: "https://gateway.example.test",
        controlUi: { root: "/custom/ui", basePath: " /remote/// " },
      },
      "configured",
      false,
      "https://gateway.example.test/remote",
    ],
  ] as const)(
    "projects Control UI location and capabilities for %j",
    async (gateway, source, browserFocus, controlUiUrl) => {
      const context = makeContext("operator", ["operator.read"]);
      context.configSnapshot = { gateway };
      await sendHello(context);
      expect(helloPayload(context)?.server).toMatchObject({
        buildId: "build-a",
        controlUiBuildSource: source,
      });
      expect(
        helloPayload(context)?.features.capabilities?.includes("control-ui-browser-focus"),
      ).toBe(browserFocus);
      expect(helloPayload(context)?.controlUiUrl).toBe(controlUiUrl);
      if (controlUiUrl === undefined) {
        expect(helloPayload(context)).not.toHaveProperty("controlUiUrl");
      }
    },
  );

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
    await sendHello(context, state, "owner-profile");
    expectRedactedHelloSnapshot(context);
    expect(helloPayload(context)?.auth).toEqual({
      method: "none",
      role: "operator",
      scopes: ["operator.pairing"],
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
      await sendHello(context, state, principal);
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
