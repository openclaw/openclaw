// Covers outbound session-route resolution through plugin hooks and fallback
// target parsing, plus best-effort session route persistence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  bindOutboundSessionEntry,
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "./outbound-session.js";

type InboundMetadataParams = {
  sessionKey?: string;
  storePath?: string;
};

const mocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly:
    vi.fn<(params: { sessionKey: string; storePath: string }) => SessionEntry | undefined>(),
  updateSessionLastRoute: vi.fn(async (_params: InboundMetadataParams) => ({
    sessionId: "session-1",
    updatedAt: 1,
  })),
  resolveStorePath: vi.fn(
    (_store: unknown, params?: { agentId?: string }) => `/stores/${params?.agentId ?? "main"}.json`,
  ),
}));

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} params to be an object`);
  }
  return arg as Record<string, unknown>;
}

vi.mock("../../config/sessions/inbound.runtime.js", () => ({
  resolveSessionStorePathCore: mocks.resolveStorePath,
  updateSessionLastRoute: mocks.updateSessionLastRoute,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));

type SessionRouteResolver = NonNullable<
  NonNullable<ChannelPlugin["messaging"]>["resolveOutboundSessionRoute"]
>;
type TargetChatTypeResolver = NonNullable<
  NonNullable<ChannelPlugin["messaging"]>["inferTargetChatType"]
>;

const resolvePluginRoute = vi.fn<SessionRouteResolver>();
const inferTargetChatType = vi.fn<TargetChatTypeResolver>();
const perChannelPeerSessionCfg = { session: { dmScope: "per-channel-peer" } } as const;

function createOpaqueRoute(): OutboundSessionRoute {
  return {
    sessionKey: "agent:worker:route-fixture:channel:MiXeD:thread:PluginThread",
    baseSessionKey: "agent:worker:route-fixture:channel:MiXeD",
    recipientSessionExact: "delivery-identity",
    peer: { kind: "channel", id: "NativeRoom" },
    chatType: "channel",
    from: "route-fixture:NativeRoom",
    to: "channel:NativeRoom",
    threadId: "PluginThread",
    displayName: "Plugin room",
  };
}

const imessageRoutePlugin = {
  ...createChannelTestPluginBase({ id: "imessage" }),
  messaging: {
    resolveOutboundSessionRoute: () => ({
      sessionKey: "agent:main:imessage:direct:Alice",
      baseSessionKey: "agent:main:imessage:direct:Alice",
      peer: { kind: "direct" as const, id: "Alice" },
      chatType: "direct" as const,
      from: "imessage:Alice",
      to: "imessage:Alice",
    }),
  },
} satisfies ChannelPlugin;

const telegramRoutePlugin = {
  ...createChannelTestPluginBase({ id: "telegram" }),
  messaging: {
    resolveOutboundSessionRoute: () => ({
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
      baseSessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
      peer: { kind: "group" as const, id: "-1001234567890:topic:42" },
      chatType: "group" as const,
      from: "telegram:group:-1001234567890:topic:42",
      to: "telegram:-1001234567890:topic:42",
    }),
  },
} satisfies ChannelPlugin;

describe("resolveOutboundSessionRoute", () => {
  it("awaits the plugin route before applying a resolved directory display name", async () => {
    const pluginRoute = createOpaqueRoute();
    resolvePluginRoute.mockResolvedValueOnce(pluginRoute);

    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel: "route-fixture",
      agentId: "main",
      target: "user-42",
      resolvedTarget: {
        to: "user-42",
        kind: "user",
        display: "Alice",
        source: "directory",
        resolutionSource: "directory",
      },
    });

    expect(route).toStrictEqual({ ...createOpaqueRoute(), displayName: "Alice" });
  });

  it("keeps directory identifier fallbacks out of durable session names", async () => {
    const roomId = "8f560ffb-37e2-4078-a6c4-83e4d72e94b3";
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel: "telegram",
      plugin: telegramRoutePlugin,
      agentId: "main",
      target: `group:${roomId}`,
      resolvedTarget: {
        to: `group:${roomId}`,
        kind: "group",
        display: roomId,
        source: "directory",
        resolutionSource: "directory",
      },
    });

    expect(route?.displayName).toBeUndefined();
  });

  it("carries an iMessage plugin contact alias into the session route", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel: "imessage",
      plugin: imessageRoutePlugin,
      agentId: "main",
      target: "imessage:Alice",
      resolvedTarget: {
        to: "imessage:Alice",
        kind: "user",
        display: "Alice",
        source: "normalized",
        resolutionSource: "plugin",
      },
    });

    expect(route?.displayName).toBe("Alice");
  });

  it("keeps normalized route displays out of durable session names", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel: "telegram",
      plugin: telegramRoutePlugin,
      agentId: "main",
      target: "-1001234567890:topic:42",
      resolvedTarget: {
        to: "telegram:-1001234567890:topic:42",
        kind: "group",
        display: "telegram:-1001234567890:topic:42",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });

    expect(route?.displayName).toBeUndefined();
  });

  beforeEach(() => {
    mocks.updateSessionLastRoute.mockClear();
    mocks.resolveStorePath.mockClear();
    resolvePluginRoute.mockReset();
    inferTargetChatType.mockReset();
    const plugins: ChannelPlugin[] = [
      {
        ...createChannelTestPluginBase({ id: "route-fixture" }),
        messaging: { resolveOutboundSessionRoute: resolvePluginRoute },
      },
      {
        ...createChannelTestPluginBase({
          id: "fallbackchat",
          capabilities: { chatTypes: ["direct", "group", "channel"] },
        }),
        messaging: { inferTargetChatType, targetPrefixes: ["fallbackchat"] },
      },
    ];
    setActivePluginRegistry(
      createTestRegistry(
        plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" })),
      ),
    );
  });

  it.each(["registry", "prepared"] as const)(
    "forwards the complete route request to the %s plugin and preserves its opaque result",
    async (source) => {
      const pluginRoute = createOpaqueRoute();
      const resolver = source === "prepared" ? vi.fn<SessionRouteResolver>() : resolvePluginRoute;
      resolver.mockReturnValueOnce(pluginRoute);
      const plugin = {
        ...createChannelTestPluginBase({ id: "route-fixture" }),
        messaging: { resolveOutboundSessionRoute: resolver },
      } satisfies ChannelPlugin;
      const cfg = { session: { dmScope: "per-channel-peer" } } as const;
      const resolvedTarget = {
        to: "channel:resolved-room",
        kind: "channel",
        source: "directory",
        resolutionSource: "directory",
      } as const;

      const route = await resolveOutboundSessionRoute({
        cfg,
        channel: "route-fixture",
        ...(source === "prepared" ? { plugin } : {}),
        agentId: "worker",
        accountId: "secondary",
        target: "  raw-target  ",
        resolvedTarget,
        currentSessionKey: "agent:worker:main",
        replyToId: "reply-17",
        threadId: 42,
        deliveryPurpose: "heartbeat-owner",
      });

      expect(resolver).toHaveBeenCalledExactlyOnceWith({
        cfg,
        channel: "route-fixture",
        ...(source === "prepared" ? { plugin } : {}),
        agentId: "worker",
        accountId: "secondary",
        target: "raw-target",
        resolvedTarget,
        currentSessionKey: "agent:worker:main",
        replyToId: "reply-17",
        threadId: 42,
        deliveryPurpose: "heartbeat-owner",
      });
      expect(resolver.mock.calls[0]?.[0].cfg).toBe(cfg);
      expect(resolver.mock.calls[0]?.[0].resolvedTarget).toBe(resolvedTarget);
      expect(route).toStrictEqual(createOpaqueRoute());
      if (source === "prepared") {
        expect(resolvePluginRoute).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves a plugin's null result instead of using generic target fallback", async () => {
    resolvePluginRoute.mockResolvedValueOnce(null);

    await expect(
      resolveOutboundSessionRoute({
        cfg: perChannelPeerSessionCfg,
        channel: "route-fixture",
        agentId: "main",
        target: "user:alice",
      }),
    ).resolves.toBeNull();
  });

  it("propagates the plugin's exact rejection instead of using generic target fallback", async () => {
    const error = new Error("route unavailable");
    resolvePluginRoute.mockRejectedValueOnce(error);

    await expect(
      resolveOutboundSessionRoute({
        cfg: perChannelPeerSessionCfg,
        channel: "route-fixture",
        agentId: "main",
        target: "user:alice",
      }),
    ).rejects.toBe(error);
  });

  it.each([
    {
      name: "group binding collapses an exact room into main",
      globalSession: { groupScope: "per-group" as const },
      peer: { kind: "group" as const, id: "team-room" },
      bindingAgentId: "main",
      bindingSession: { groupScope: "main" as const },
      pluginBaseKey: "agent:main:bound-channel:group:team-room",
      pluginSessionKey: "agent:main:bound-channel:group:team-room",
      expectedSessionKey: "agent:main:main",
      expectedBaseSessionKey: "agent:main:main",
      expectedRecipientSessionExact: true,
    },
    {
      name: "DM binding collapses an exact peer into main and preserves its thread",
      globalSession: { dmScope: "per-channel-peer" as const },
      peer: { kind: "direct" as const, id: "alice" },
      bindingAgentId: "main",
      bindingSession: { dmScope: "main" as const },
      pluginBaseKey: "agent:main:bound-channel:direct:alice",
      pluginSessionKey: "agent:main:bound-channel:direct:alice:thread:topic-1",
      expectedSessionKey: "agent:main:main:thread:topic-1",
      expectedBaseSessionKey: "agent:main:main",
      expectedRecipientSessionExact: true,
    },
    {
      name: "cross-agent binding downgrades an agent-local exact route",
      globalSession: { dmScope: "per-channel-peer" as const },
      peer: { kind: "direct" as const, id: "alice" },
      bindingAgentId: "other",
      bindingSession: { dmScope: "per-channel-peer" as const },
      pluginBaseKey: "agent:main:bound-channel:direct:alice",
      pluginSessionKey: "agent:main:bound-channel:direct:alice",
      expectedSessionKey: "agent:main:bound-channel:direct:alice",
      expectedBaseSessionKey: "agent:main:bound-channel:direct:alice",
      expectedRecipientSessionExact: false,
    },
  ])("applies $name before returning the canonical route", async (testCase) => {
    const plugin = {
      ...createChannelTestPluginBase({ id: "bound-channel" }),
      messaging: {
        resolveOutboundSessionRoute: () => ({
          sessionKey: testCase.pluginSessionKey,
          baseSessionKey: testCase.pluginBaseKey,
          recipientSessionExact: true as const,
          peer: testCase.peer,
          chatType: testCase.peer.kind === "direct" ? ("direct" as const) : ("group" as const),
          from: `bound-channel:${testCase.peer.id}`,
          to: testCase.peer.id,
        }),
      },
    } satisfies ChannelPlugin;
    const route = await resolveOutboundSessionRoute({
      cfg: {
        session: testCase.globalSession,
        bindings: [
          {
            agentId: testCase.bindingAgentId,
            match: { channel: "bound-channel", peer: testCase.peer },
            session: testCase.bindingSession,
          },
        ],
      } as OpenClawConfig,
      channel: "bound-channel",
      plugin,
      agentId: "main",
      target: testCase.peer.id,
    });

    expect(route?.sessionKey).toBe(testCase.expectedSessionKey);
    expect(route?.baseSessionKey).toBe(testCase.expectedBaseSessionKey);
    expect(route?.recipientSessionExact).toBe(testCase.expectedRecipientSessionExact);
  });

  it.each([
    {
      name: "explicit group prefix",
      target: "group:ops",
      inferredKind: undefined,
      sessionKey: "agent:main:fallbackchat:group:ops",
      peer: { kind: "group", id: "ops" },
      chatType: "group",
      from: "fallbackchat:group:ops",
      to: "channel:ops",
    },
    {
      name: "plugin-inferred group",
      target: "spaces/AAA",
      inferredKind: "group",
      sessionKey: "agent:main:fallbackchat:group:spaces/aaa",
      peer: { kind: "group", id: "spaces/AAA" },
      chatType: "group",
      from: "fallbackchat:group:spaces/AAA",
      to: "channel:spaces/AAA",
    },
    {
      name: "explicit user prefix",
      target: "user:U123",
      inferredKind: undefined,
      sessionKey: "agent:main:fallbackchat:direct:u123",
      peer: { kind: "direct", id: "U123" },
      chatType: "direct",
      from: "fallbackchat:U123",
      to: "user:U123",
    },
    {
      name: "explicit thread prefix",
      target: "thread:abc",
      inferredKind: undefined,
      sessionKey: "agent:main:fallbackchat:channel:abc",
      peer: { kind: "channel", id: "abc" },
      chatType: "channel",
      from: "fallbackchat:channel:abc",
      to: "channel:abc",
    },
  ] as const)(
    "uses generic fallback for $name",
    async ({ name: _name, target, inferredKind, sessionKey, ...expected }) => {
      inferTargetChatType.mockReturnValue(inferredKind);
      const route = await resolveOutboundSessionRoute({
        cfg: perChannelPeerSessionCfg,
        channel: "fallbackchat",
        agentId: "main",
        target,
      });

      expect(inferTargetChatType).toHaveBeenCalledWith({ to: target });
      expect(route).toEqual({
        ...expected,
        sessionKey,
        baseSessionKey: sessionKey,
        recipientSessionExact: false,
      });
    },
  );

  it("uses a resolved direct-only target kind to avoid phantom group sessions", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel: "openclaw-weixin",
      agentId: "main",
      target: "wxid_abc123@im.wechat",
      resolvedTarget: {
        to: "wxid_abc123@im.wechat",
        kind: "user",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });

    expect(route).toEqual({
      sessionKey: "agent:main:openclaw-weixin:direct:wxid_abc123@im.wechat",
      baseSessionKey: "agent:main:openclaw-weixin:direct:wxid_abc123@im.wechat",
      recipientSessionExact: false,
      peer: { kind: "direct", id: "wxid_abc123@im.wechat" },
      from: "openclaw-weixin:wxid_abc123@im.wechat",
      to: "user:wxid_abc123@im.wechat",
      chatType: "direct",
    });
  });
});

describe("ensureOutboundSessionEntry", () => {
  beforeEach(() => {
    mocks.loadSessionEntryReadOnly.mockReset();
    mocks.updateSessionLastRoute.mockClear();
    mocks.resolveStorePath.mockClear();
  });

  it("persists metadata in the owning session store for the route session key", async () => {
    await ensureOutboundSessionEntry({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } as OpenClawConfig,
      channel: "workspace",
      route: {
        sessionKey: "agent:main:workspace:channel:c1",
        baseSessionKey: "agent:work:workspace:channel:resolved",
        peer: { kind: "channel", id: "c1" },
        chatType: "channel",
        from: "workspace:channel:C1",
        to: "channel:C1",
      },
    });

    expect(mocks.resolveStorePath).toHaveBeenCalledWith("/stores/{agentId}.json", {
      agentId: "main",
    });
    expect(mocks.updateSessionLastRoute).toHaveBeenCalledOnce();
    const metadata = firstMockArg(mocks.updateSessionLastRoute, "updateSessionLastRoute");
    expect(metadata.storePath).toBe("/stores/main.json");
    expect(metadata.sessionKey).toBe("agent:main:workspace:channel:c1");
    expect(metadata.ctx).toMatchObject({
      NativeChannelId: "c1",
      OriginatingTo: "channel:C1",
    });
  });

  it("persists a resolved target display name as presentation metadata", async () => {
    await ensureOutboundSessionEntry({
      cfg: {} as OpenClawConfig,
      channel: "imessage",
      route: {
        sessionKey: "agent:main:imessage:direct:+15551234567",
        baseSessionKey: "agent:main:imessage:direct:+15551234567",
        peer: { kind: "direct", id: "+15551234567" },
        chatType: "direct",
        from: "auto:+15551234567",
        to: "auto:+15551234567",
        displayName: "Alice",
      },
    });

    const metadata = firstMockArg(mocks.updateSessionLastRoute, "updateSessionLastRoute");
    expect(metadata.ctx).toMatchObject({ ConversationLabel: "Alice" });
  });

  it("does not persist an identifier-only target as a group title", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: { session: { groupScope: "per-group" } } as OpenClawConfig,
      channel: "telegram",
      plugin: telegramRoutePlugin,
      agentId: "main",
      target: "-1001234567890:topic:42",
      resolvedTarget: {
        to: "telegram:-1001234567890:topic:42",
        kind: "group",
        display: "telegram:-1001234567890:topic:42",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });
    expect(route).toBeDefined();
    if (!route) {
      return;
    }
    expect(route.displayName).toBeUndefined();

    await ensureOutboundSessionEntry({
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      route,
    });

    const metadata = firstMockArg(mocks.updateSessionLastRoute, "updateSessionLastRoute");
    expect((metadata.ctx as Record<string, unknown>).GroupSubject).toBeUndefined();
  });

  it("persists the canonical direct peer separately from its adapter target", async () => {
    await ensureOutboundSessionEntry({
      cfg: {} as OpenClawConfig,
      channel: "reef",
      route: {
        sessionKey: "agent:main:main",
        baseSessionKey: "agent:main:main",
        peer: { kind: "direct", id: "peer-agent" },
        chatType: "direct",
        from: "reef:peer-agent",
        to: "reef:peer-agent",
      },
    });

    const metadata = firstMockArg(mocks.updateSessionLastRoute, "updateSessionLastRoute");
    expect(metadata.ctx).toMatchObject({
      NativeDirectUserId: "peer-agent",
      OriginatingTo: "reef:peer-agent",
    });
    expect(metadata.createIfMissing).toBe(true);
  });

  it.each(["operator", "required-parent", "unstamped-parent"] as const)(
    "carries %s creation policy without requiring current role configuration",
    async (source) => {
      const actor = { type: "human" as const, source: "profile" as const, id: "outbound-creator" };
      const creation = { via: "operator" as const, actor, sandbox: "required" as const };
      mocks.loadSessionEntryReadOnly.mockImplementation((params) =>
        params.sessionKey === "agent:other:main" && params.storePath === "/stores/other.json"
          ? {
              sessionId: "source-session",
              updatedAt: 1,
              createdVia: "operator",
              createdActor: actor,
              ...(source === "required-parent" ? { sandbox: "required" as const } : {}),
            }
          : undefined,
      );

      await ensureOutboundSessionEntry({
        cfg: {},
        channel: "reef",
        route: {
          sessionKey: "agent:main:reef:direct:first-contact",
          baseSessionKey: "agent:main:reef:direct:first-contact",
          peer: { kind: "direct", id: "first-contact" },
          chatType: "direct",
          from: "reef:first-contact",
          to: "user:first-contact",
        },
        ...(source === "operator" ? { creation } : { sourceSessionKey: "agent:other:main" }),
      });

      const metadata = firstMockArg(mocks.updateSessionLastRoute, "updateSessionLastRoute");
      if (source === "unstamped-parent") {
        expect(metadata.ctx).not.toHaveProperty("SessionCreation", expect.anything());
      } else {
        expect(metadata.ctx).toMatchObject({ SessionCreation: creation });
      }
    },
  );

  it("keeps ordinary outbound sends best-effort when route persistence fails", async () => {
    mocks.updateSessionLastRoute.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      ensureOutboundSessionEntry({
        cfg: {} as OpenClawConfig,
        channel: "reef",
        route: {
          sessionKey: "agent:main:main",
          baseSessionKey: "agent:main:main",
          peer: { kind: "direct", id: "peer-agent" },
          chatType: "direct",
          from: "reef:peer-agent",
          to: "reef:peer-agent",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("surfaces route persistence failures when a conversation requires binding", async () => {
    mocks.updateSessionLastRoute.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      bindOutboundSessionEntry({
        cfg: {} as OpenClawConfig,
        channel: "reef",
        route: {
          sessionKey: "agent:main:main",
          baseSessionKey: "agent:main:main",
          peer: { kind: "direct", id: "peer-agent" },
          chatType: "direct",
          from: "reef:peer-agent",
          to: "reef:peer-agent",
        },
      }),
    ).rejects.toThrow("storage unavailable");
  });
});
