import { beforeEach, describe, expect, it } from "vitest";
import { setDefaultChannelPluginRegistryForTests } from "../../commands/channel-test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";

describe("resolveOutboundSessionRoute", () => {
  beforeEach(() => {
    setDefaultChannelPluginRegistryForTests();
  });

  const baseConfig = {} as OpenClawConfig;

  it("resolves provider-specific session routes", async () => {
    const perChannelPeerCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;
    const identityLinksCfg = {
      session: {
        dmScope: "per-peer",
        identityLinks: {
          alice: ["discord:123"],
        },
      },
    } as OpenClawConfig;
    const slackMpimCfg = {
      channels: {
        slack: {
          dm: {
            groupChannels: ["G123"],
          },
        },
      },
    } as OpenClawConfig;
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      channel: string;
      target: string;
      replyToId?: string;
      threadId?: string;
      expected: {
        sessionKey: string;
        from?: string;
        to?: string;
        threadId?: string | number;
        chatType?: "channel" | "direct" | "group";
      };
    }> = [
      {
        name: "WhatsApp group jid",
        cfg: baseConfig,
        channel: "whatsapp",
        target: "120363040000000000@g.us",
        expected: {
          sessionKey: "agent:main:whatsapp:group:120363040000000000@g.us",
          from: "120363040000000000@g.us",
          to: "120363040000000000@g.us",
          chatType: "group",
        },
      },
      {
        name: "Matrix room target",
        cfg: baseConfig,
        channel: "matrix",
        target: "room:!ops:matrix.example",
        expected: {
          sessionKey: "agent:main:matrix:channel:!ops:matrix.example",
          from: "matrix:channel:!ops:matrix.example",
          to: "room:!ops:matrix.example",
          chatType: "channel",
        },
      },
      {
        name: "MSTeams conversation target",
        cfg: baseConfig,
        channel: "msteams",
        target: "conversation:19:meeting_abc@thread.tacv2",
        expected: {
          sessionKey: "agent:main:msteams:channel:19:meeting_abc@thread.tacv2",
          from: "msteams:channel:19:meeting_abc@thread.tacv2",
          to: "conversation:19:meeting_abc@thread.tacv2",
          chatType: "channel",
        },
      },
      {
        name: "Slack thread",
        cfg: baseConfig,
        channel: "slack",
        target: "channel:C123",
        replyToId: "456",
        expected: {
          sessionKey: "agent:main:slack:channel:c123:thread:456",
          from: "slack:channel:C123",
          to: "channel:C123",
          threadId: "456",
        },
      },
      {
        name: "Telegram topic group",
        cfg: baseConfig,
        channel: "telegram",
        target: "-100123456:topic:42",
        expected: {
          sessionKey: "agent:main:telegram:group:-100123456:topic:42",
          from: "telegram:group:-100123456:topic:42",
          to: "telegram:-100123456",
          threadId: 42,
        },
      },
      {
        name: "Telegram DM with topic",
        cfg: perChannelPeerCfg,
        channel: "telegram",
        target: "123456789:topic:99",
        expected: {
          sessionKey: "agent:main:telegram:direct:123456789:thread:99",
          from: "telegram:123456789:topic:99",
          to: "telegram:123456789",
          threadId: 99,
          chatType: "direct",
        },
      },
      {
        name: "Telegram unresolved username DM",
        cfg: perChannelPeerCfg,
        channel: "telegram",
        target: "@alice",
        expected: {
          sessionKey: "agent:main:telegram:direct:@alice",
          chatType: "direct",
        },
      },
      {
        name: "Telegram DM scoped threadId fallback",
        cfg: perChannelPeerCfg,
        channel: "telegram",
        target: "12345",
        threadId: "12345:99",
        expected: {
          sessionKey: "agent:main:telegram:direct:12345:thread:99",
          from: "telegram:12345:topic:99",
          to: "telegram:12345",
          threadId: 99,
          chatType: "direct",
        },
      },
      {
        name: "identity-links per-peer",
        cfg: identityLinksCfg,
        channel: "discord",
        target: "user:123",
        expected: {
          sessionKey: "agent:main:direct:alice",
        },
      },
      {
        name: "Nextcloud Talk room target",
        cfg: baseConfig,
        channel: "nextcloud-talk",
        target: "room:opsroom42",
        expected: {
          sessionKey: "agent:main:nextcloud-talk:group:opsroom42",
          from: "nextcloud-talk:room:opsroom42",
          to: "nextcloud-talk:opsroom42",
          chatType: "group",
        },
      },
      {
        name: "BlueBubbles chat_* prefix stripping",
        cfg: baseConfig,
        channel: "bluebubbles",
        target: "chat_guid:ABC123",
        expected: {
          sessionKey: "agent:main:bluebubbles:group:abc123",
          from: "group:ABC123",
        },
      },
      {
        name: "Zalo direct target",
        cfg: perChannelPeerCfg,
        channel: "zalo",
        target: "zl:123456",
        expected: {
          sessionKey: "agent:main:zalo:direct:123456",
          from: "zalo:123456",
          to: "zalo:123456",
          chatType: "direct",
        },
      },
      {
        name: "Zalo Personal DM target",
        cfg: perChannelPeerCfg,
        channel: "zalouser",
        target: "123456",
        expected: {
          sessionKey: "agent:main:zalouser:direct:123456",
          chatType: "direct",
        },
      },
      {
        name: "Nostr prefixed target",
        cfg: perChannelPeerCfg,
        channel: "nostr",
        target: "nostr:npub1example",
        expected: {
          sessionKey: "agent:main:nostr:direct:npub1example",
          from: "nostr:npub1example",
          to: "nostr:npub1example",
          chatType: "direct",
        },
      },
      {
        name: "Tlon group target",
        cfg: baseConfig,
        channel: "tlon",
        target: "group:~zod/main",
        expected: {
          sessionKey: "agent:main:tlon:group:chat/~zod/main",
          from: "tlon:group:chat/~zod/main",
          to: "tlon:chat/~zod/main",
          chatType: "group",
        },
      },
      {
        name: "Slack mpim allowlist -> group key",
        cfg: slackMpimCfg,
        channel: "slack",
        target: "channel:G123",
        expected: {
          sessionKey: "agent:main:slack:group:g123",
          from: "slack:group:G123",
        },
      },
      {
        name: "Feishu explicit group prefix keeps group routing",
        cfg: baseConfig,
        channel: "feishu",
        target: "group:oc_group_chat",
        expected: {
          sessionKey: "agent:main:feishu:group:oc_group_chat",
          from: "feishu:group:oc_group_chat",
          to: "oc_group_chat",
          chatType: "group",
        },
      },
      {
        name: "Feishu explicit dm prefix keeps direct routing",
        cfg: perChannelPeerCfg,
        channel: "feishu",
        target: "dm:oc_dm_chat",
        expected: {
          sessionKey: "agent:main:feishu:direct:oc_dm_chat",
          from: "feishu:oc_dm_chat",
          to: "oc_dm_chat",
          chatType: "direct",
        },
      },
      {
        name: "Feishu bare oc_ target defaults to direct routing",
        cfg: perChannelPeerCfg,
        channel: "feishu",
        target: "oc_ambiguous_chat",
        expected: {
          sessionKey: "agent:main:feishu:direct:oc_ambiguous_chat",
          from: "feishu:oc_ambiguous_chat",
          to: "oc_ambiguous_chat",
          chatType: "direct",
        },
      },
    ];

    for (const testCase of cases) {
      const route = await resolveOutboundSessionRoute({
        cfg: testCase.cfg,
        channel: testCase.channel,
        agentId: "main",
        target: testCase.target,
        replyToId: testCase.replyToId,
        threadId: testCase.threadId,
      });
      expect(route?.sessionKey, testCase.name).toBe(testCase.expected.sessionKey);
      if (testCase.expected.from !== undefined) {
        expect(route?.from, testCase.name).toBe(testCase.expected.from);
      }
      if (testCase.expected.to !== undefined) {
        expect(route?.to, testCase.name).toBe(testCase.expected.to);
      }
      if (testCase.expected.threadId !== undefined) {
        expect(route?.threadId, testCase.name).toBe(testCase.expected.threadId);
      }
      if (testCase.expected.chatType !== undefined) {
        expect(route?.chatType, testCase.name).toBe(testCase.expected.chatType);
      }
    }
  });

  it("uses resolved Discord user targets to route bare numeric ids as DMs", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } } as OpenClawConfig,
      channel: "discord",
      agentId: "main",
      target: "123",
      resolvedTarget: {
        to: "user:123",
        kind: "user",
        source: "directory",
      },
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:discord:direct:123",
      from: "discord:123",
      to: "user:123",
      chatType: "direct",
    });
  });

  it("uses resolved Mattermost user targets to route bare ids as DMs", async () => {
    const userId = "dthcxgoxhifn3pwh65cut3ud3w";
    const route = await resolveOutboundSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } } as OpenClawConfig,
      channel: "mattermost",
      agentId: "main",
      target: userId,
      resolvedTarget: {
        to: `user:${userId}`,
        kind: "user",
        source: "directory",
      },
    });

    expect(route).toMatchObject({
      sessionKey: `agent:main:mattermost:direct:${userId}`,
      from: `mattermost:${userId}`,
      to: `user:${userId}`,
      chatType: "direct",
    });
  });

  it("rejects bare numeric Discord targets when the caller has no kind hint", async () => {
    await expect(
      resolveOutboundSessionRoute({
        cfg: { session: { dmScope: "per-channel-peer" } } as OpenClawConfig,
        channel: "discord",
        agentId: "main",
        target: "123",
      }),
    ).rejects.toThrow(/Ambiguous Discord recipient/);
  });
});
