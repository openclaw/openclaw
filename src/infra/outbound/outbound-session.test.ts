// Covers outbound session-route resolution through plugin hooks and fallback
// target parsing, plus best-effort session route persistence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import {
  bindOutboundSessionEntry,
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "./outbound-session.js";
import { setMinimalOutboundSessionPluginRegistryForTests } from "./outbound-session.test-helpers.js";

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

vi.mock("../../config/sessions/inbound.runtime.js", () => ({
  resolveSessionStorePathCore: mocks.resolveStorePath,
  updateSessionLastRoute: mocks.updateSessionLastRoute,
}));

// mock-isolation: Outbound routing tests supply session rows without starting persistent storage.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (params: { sessionKey: string; storePath: string }) =>
    mocks.loadSessionEntryReadOnly(params),
}));

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
  it("carries a resolved directory display name into the session route", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel: "guildchat",
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

    expect(route?.displayName).toBe("Alice");
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

  beforeEach(() => {
    mocks.updateSessionLastRoute.mockClear();
    mocks.resolveStorePath.mockClear();
    setMinimalOutboundSessionPluginRegistryForTests();
  });

  const baseConfig = {} as OpenClawConfig;
  const perChannelPeerCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;
  const identityLinksCfg = {
    session: {
      dmScope: "per-peer",
      identityLinks: {
        alice: ["guildchat:123"],
      },
    },
  } as OpenClawConfig;
  const workspaceMpimCfg = {
    channels: {
      workspace: {
        dm: {
          groupChannels: ["G123"],
        },
      },
    },
  } as OpenClawConfig;

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

    expect(route).toMatchObject({
      sessionKey: testCase.expectedSessionKey,
      baseSessionKey: testCase.expectedBaseSessionKey,
      recipientSessionExact: testCase.expectedRecipientSessionExact,
    });
  });

  type RouteCase = Omit<Parameters<typeof resolveOutboundSessionRoute>[0], "agentId"> & {
    expected: Partial<OutboundSessionRoute> & Pick<OutboundSessionRoute, "sessionKey">;
  };
  async function expectResolvedRoute({ expected, ...params }: RouteCase) {
    expect(await resolveOutboundSessionRoute({ agentId: "main", ...params })).toMatchObject(
      expected,
    );
  }

  function routeCase(
    channel: string,
    target: string,
    expected: RouteCase["expected"],
    cfg: OpenClawConfig = baseConfig,
    threadId?: string,
  ) {
    return { name: channel + ": " + target, cfg, channel, target, expected, threadId };
  }

  const dmCase = (channel: string, target: string, expected: RouteCase["expected"]) =>
    routeCase(channel, target, expected, perChannelPeerCfg);

  const perChannelPeerSessionCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;

  it.each([
    routeCase(
      "mobilechat",
      "120363040000000000@g.us",
      {
        sessionKey: "agent:main:main",
        chatType: "group",
      },
      { session: { groupScope: "main" } } as OpenClawConfig,
    ),
    routeCase("matrix", "room:!ops:matrix.example", {
      sessionKey: "agent:main:matrix:channel:!ops:matrix.example",
      from: "matrix:channel:!ops:matrix.example",
      to: "room:!ops:matrix.example",
      chatType: "channel",
    }),
    routeCase("meetingchat", "conversation:19:meeting_abc@thread.tacv2", {
      sessionKey: "agent:main:meetingchat:channel:19:meeting_abc@thread.tacv2",
      from: "meetingchat:channel:19:meeting_abc@thread.tacv2",
      to: "conversation:19:meeting_abc@thread.tacv2",
      chatType: "channel",
    }),
    routeCase("forum", "-100123456:topic:42", {
      sessionKey: "agent:main:forum:group:-100123456:topic:42",
      from: "forum:group:-100123456:topic:42",
      to: "forum:-100123456",
      threadId: 42,
    }),
    dmCase("forum", "123456789:topic:99", {
      sessionKey: "agent:main:forum:direct:123456789:thread:99",
      from: "forum:123456789:topic:99",
      to: "forum:123456789",
      threadId: 99,
      chatType: "direct",
    }),
    dmCase("forum", "@alice", {
      sessionKey: "agent:main:forum:direct:@alice",
      chatType: "direct",
    }),
    routeCase(
      "forum",
      "12345",
      {
        sessionKey: "agent:main:forum:direct:12345:thread:99",
        from: "forum:12345:topic:99",
        to: "forum:12345",
        threadId: 99,
        chatType: "direct",
      },
      perChannelPeerCfg,
      "12345:99",
    ),
    routeCase(
      "guildchat",
      "user:123",
      {
        sessionKey: "agent:main:direct:alice",
      },
      identityLinksCfg,
    ),
    routeCase("nextcloud-talk", "room:opsroom42", {
      sessionKey: "agent:main:nextcloud-talk:group:opsroom42",
      from: "nextcloud-talk:room:opsroom42",
      to: "nextcloud-talk:opsroom42",
      chatType: "group",
    }),
    routeCase("localchat", "chat_guid:ABC123", {
      sessionKey: "agent:main:localchat:group:abc123",
      from: "group:ABC123",
    }),
    dmCase("zalo", "zl:123456", {
      sessionKey: "agent:main:zalo:direct:123456",
      from: "zalo:123456",
      to: "zalo:123456",
      chatType: "direct",
    }),
    dmCase("zalouser", "123456", {
      sessionKey: "agent:main:zalouser:direct:123456",
      chatType: "direct",
    }),
    dmCase("nostr", "nostr:npub1example", {
      sessionKey: "agent:main:nostr:direct:npub1example",
      from: "nostr:npub1example",
      to: "nostr:npub1example",
      chatType: "direct",
    }),
    routeCase("tlon", "group:~zod/main", {
      sessionKey: "agent:main:tlon:group:chat/~zod/main",
      from: "tlon:group:chat/~zod/main",
      to: "tlon:chat/~zod/main",
      chatType: "group",
    }),
    routeCase(
      "workspace",
      "channel:G123",
      {
        sessionKey: "agent:main:workspace:group:g123",
        from: "workspace:group:G123",
      },
      workspaceMpimCfg,
    ),
    routeCase("collabchat", "group:oc_group_chat", {
      sessionKey: "agent:main:collabchat:group:oc_group_chat",
      from: "collabchat:group:oc_group_chat",
      to: "oc_group_chat",
      chatType: "group",
    }),
    dmCase("collabchat", "dm:oc_dm_chat", {
      sessionKey: "agent:main:collabchat:direct:oc_dm_chat",
      from: "collabchat:oc_dm_chat",
      to: "oc_dm_chat",
      chatType: "direct",
    }),
    dmCase("collabchat", "oc_ambiguous_chat", {
      sessionKey: "agent:main:collabchat:direct:oc_ambiguous_chat",
      from: "collabchat:oc_ambiguous_chat",
      to: "oc_ambiguous_chat",
      chatType: "direct",
    }),
    dmCase("workspace", "user:U12345ABC", {
      sessionKey: "agent:main:workspace:direct:u12345abc",
      from: "workspace:U12345ABC",
      to: "user:U12345ABC",
      chatType: "direct",
    }),
    routeCase("workspace", "channel:C999XYZ", {
      sessionKey: "agent:main:workspace:channel:c999xyz",
      from: "workspace:channel:C999XYZ",
      to: "channel:C999XYZ",
      chatType: "channel",
    }),
    routeCase("fallbackchat", "spaces/AAA", {
      sessionKey: "agent:main:fallbackchat:group:spaces/aaa",
      from: "fallbackchat:group:spaces/AAA",
      to: "channel:spaces/AAA",
      chatType: "group",
    }),
    dmCase("fallbackchat", "user:U123", {
      sessionKey: "agent:main:fallbackchat:direct:u123",
      from: "fallbackchat:U123",
      to: "user:U123",
      chatType: "direct",
    }),
  ])("$name", async ({ name: _name, ...params }) => {
    await expectResolvedRoute(params);
  });

  it.each([
    {
      name: "uses resolved GuildChat channel targets to route bare numeric ids as channels without thread suffixes",
      target: "456",
      threadId: "789",
      resolvedTarget: {
        to: "channel:456",
        kind: "channel" as const,
        source: "directory" as const,
        resolutionSource: "directory" as const,
      },
      expected: {
        sessionKey: "agent:main:guildchat:channel:456",
        baseSessionKey: "agent:main:guildchat:channel:456",
        from: "guildchat:channel:456",
        to: "channel:456",
        chatType: "channel",
        threadId: "789",
      },
    },
    {
      name: "uses resolved BoardChat user targets to route bare ids as DMs",
      target: "dthcxgoxhifn3pwh65cut3ud3w",
      channel: "boardchat",
      resolvedTarget: {
        to: "user:dthcxgoxhifn3pwh65cut3ud3w",
        kind: "user" as const,
        source: "directory" as const,
        resolutionSource: "directory" as const,
      },
      expected: {
        sessionKey: "agent:main:boardchat:direct:dthcxgoxhifn3pwh65cut3ud3w",
        from: "boardchat:dthcxgoxhifn3pwh65cut3ud3w",
        to: "user:dthcxgoxhifn3pwh65cut3ud3w",
        chatType: "direct",
      },
    },
    {
      name: "uses resolved direct-only channel user targets to avoid phantom group sessions",
      target: "wxid_abc123@im.wechat",
      channel: "openclaw-weixin",
      resolvedTarget: {
        to: "wxid_abc123@im.wechat",
        kind: "user" as const,
        source: "normalized" as const,
        resolutionSource: "normalized" as const,
      },
      expected: {
        sessionKey: "agent:main:openclaw-weixin:direct:wxid_abc123@im.wechat",
        from: "openclaw-weixin:wxid_abc123@im.wechat",
        to: "user:wxid_abc123@im.wechat",
        chatType: "direct",
      },
    },
  ])("$name", async ({ channel = "guildchat", target, threadId, resolvedTarget, expected }) => {
    const route = await resolveOutboundSessionRoute({
      cfg: perChannelPeerSessionCfg,
      channel,
      agentId: "main",
      target,
      threadId,
      resolvedTarget,
    });

    expect(route).toMatchObject(expected);
  });

  it("rejects bare numeric GuildChat targets when the caller has no kind hint", async () => {
    await expect(
      resolveOutboundSessionRoute({
        cfg: perChannelPeerSessionCfg,
        channel: "guildchat",
        agentId: "main",
        target: "123",
      }),
    ).rejects.toThrow(/Ambiguous Guild Chat recipient/);
  });
});

function readMetadata() {
  return mockFirstRecordArg(
    mocks.updateSessionLastRoute,
    "updateSessionLastRoute",
    "expected updateSessionLastRoute params to be an object",
  );
}

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
    const metadata = readMetadata();
    expect(metadata.storePath).toBe("/stores/main.json");
    expect(metadata.sessionKey).toBe("agent:main:workspace:channel:c1");
    expect(metadata.ctx).toMatchObject({
      NativeChannelId: "c1",
      OriginatingTo: "channel:C1",
    });
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

    const metadata = readMetadata();
    expect((metadata.ctx as Record<string, unknown>).GroupSubject).toBeUndefined();
  });

  it.each(["operator", "required-parent"] as const)(
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

      const metadata = mockFirstRecordArg(
        mocks.updateSessionLastRoute,
        "updateSessionLastRoute",
        "expected updateSessionLastRoute params to be an object",
      );
      expect(metadata.ctx).toMatchObject({ SessionCreation: creation });
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
