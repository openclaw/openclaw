import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { setDefaultChannelPluginRegistryForTests } from "../../commands/channel-test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import { DirectoryCache } from "./directory-cache.js";
import { buildOutboundResultEnvelope } from "./envelope.js";
import type { OutboundDeliveryJson } from "./format.js";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "./format.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  enforceCrossContextPolicy,
} from "./outbound-policy.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";
import {
  formatOutboundPayloadLog,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "./payloads.js";
import { runResolveOutboundTargetCoreTests } from "./targets.shared-test.js";

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("DirectoryCache", () => {
  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires entries after ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = new DirectoryCache<string>(1000, 10);

    cache.set("a", "value-a", cfg);
    expect(cache.get("a", cfg)).toBe("value-a");

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(cache.get("a", cfg)).toBeUndefined();
  });

  it("evicts least-recent entries when capacity is exceeded", () => {
    const cases = [
      {
        actions: [
          ["set", "a", "value-a"],
          ["set", "b", "value-b"],
          ["set", "c", "value-c"],
        ] as const,
        expected: { a: undefined, b: "value-b", c: "value-c" },
      },
      {
        actions: [
          ["set", "a", "value-a"],
          ["set", "b", "value-b"],
          ["set", "a", "value-a2"],
          ["set", "c", "value-c"],
        ] as const,
        expected: { a: "value-a2", b: undefined, c: "value-c" },
      },
    ];

    for (const testCase of cases) {
      const cache = new DirectoryCache<string>(60_000, 2);
      for (const action of testCase.actions) {
        cache.set(action[1], action[2], cfg);
      }
      expect(cache.get("a", cfg)).toBe(testCase.expected.a);
      expect(cache.get("b", cfg)).toBe(testCase.expected.b);
      expect(cache.get("c", cfg)).toBe(testCase.expected.c);
    }
  });
});

describe("buildOutboundResultEnvelope", () => {
  it("formats envelope variants", () => {
    const whatsappDelivery: OutboundDeliveryJson = {
      channel: "whatsapp",
      via: "gateway",
      to: "+1",
      messageId: "m1",
      mediaUrl: null,
    };
    const telegramDelivery: OutboundDeliveryJson = {
      channel: "telegram",
      via: "direct",
      to: "123",
      messageId: "m2",
      mediaUrl: null,
      chatId: "c1",
    };
    const discordDelivery: OutboundDeliveryJson = {
      channel: "discord",
      via: "gateway",
      to: "channel:C1",
      messageId: "m3",
      mediaUrl: null,
      channelId: "C1",
    };
    const cases = typedCases<{
      name: string;
      input: Parameters<typeof buildOutboundResultEnvelope>[0];
      expected: unknown;
    }>([
      {
        name: "flatten delivery by default",
        input: { delivery: whatsappDelivery },
        expected: whatsappDelivery,
      },
      {
        name: "keep payloads + meta",
        input: {
          payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
          meta: { foo: "bar" },
        },
        expected: {
          payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
          meta: { foo: "bar" },
        },
      },
      {
        name: "include delivery when payloads exist",
        input: { payloads: [], delivery: telegramDelivery, meta: { ok: true } },
        expected: {
          payloads: [],
          meta: { ok: true },
          delivery: telegramDelivery,
        },
      },
      {
        name: "keep wrapped delivery when flatten disabled",
        input: { delivery: discordDelivery, flattenDelivery: false },
        expected: { delivery: discordDelivery },
      },
    ]);
    for (const testCase of cases) {
      expect(buildOutboundResultEnvelope(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("formatOutboundDeliverySummary", () => {
  it("formats fallback and channel-specific detail variants", () => {
    const cases = [
      {
        name: "fallback telegram",
        channel: "telegram" as const,
        result: undefined,
        expected: "✅ Sent via Telegram. Message ID: unknown",
      },
      {
        name: "fallback imessage",
        channel: "imessage" as const,
        result: undefined,
        expected: "✅ Sent via iMessage. Message ID: unknown",
      },
      {
        name: "telegram with chat detail",
        channel: "telegram" as const,
        result: {
          channel: "telegram" as const,
          messageId: "m1",
          chatId: "c1",
        },
        expected: "✅ Sent via Telegram. Message ID: m1 (chat c1)",
      },
      {
        name: "discord with channel detail",
        channel: "discord" as const,
        result: {
          channel: "discord" as const,
          messageId: "d1",
          channelId: "chan",
        },
        expected: "✅ Sent via Discord. Message ID: d1 (channel chan)",
      },
    ];

    for (const testCase of cases) {
      expect(formatOutboundDeliverySummary(testCase.channel, testCase.result), testCase.name).toBe(
        testCase.expected,
      );
    }
  });
});

describe("buildOutboundDeliveryJson", () => {
  it("builds direct delivery payloads across provider-specific fields", () => {
    const cases = [
      {
        name: "telegram direct payload",
        input: {
          channel: "telegram" as const,
          to: "123",
          result: { channel: "telegram" as const, messageId: "m1", chatId: "c1" },
          mediaUrl: "https://example.com/a.png",
        },
        expected: {
          channel: "telegram",
          via: "direct",
          to: "123",
          messageId: "m1",
          mediaUrl: "https://example.com/a.png",
          chatId: "c1",
        },
      },
      {
        name: "whatsapp metadata",
        input: {
          channel: "whatsapp" as const,
          to: "+1",
          result: { channel: "whatsapp" as const, messageId: "w1", toJid: "jid" },
        },
        expected: {
          channel: "whatsapp",
          via: "direct",
          to: "+1",
          messageId: "w1",
          mediaUrl: null,
          toJid: "jid",
        },
      },
      {
        name: "signal timestamp",
        input: {
          channel: "signal" as const,
          to: "+1",
          result: { channel: "signal" as const, messageId: "s1", timestamp: 123 },
        },
        expected: {
          channel: "signal",
          via: "direct",
          to: "+1",
          messageId: "s1",
          mediaUrl: null,
          timestamp: 123,
        },
      },
    ];

    for (const testCase of cases) {
      expect(buildOutboundDeliveryJson(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("formatGatewaySummary", () => {
  it("formats default and custom gateway action summaries", () => {
    const cases = [
      {
        name: "default send action",
        input: { channel: "whatsapp", messageId: "m1" },
        expected: "✅ Sent via gateway (whatsapp). Message ID: m1",
      },
      {
        name: "custom action",
        input: { action: "Poll sent", channel: "discord", messageId: "p1" },
        expected: "✅ Poll sent via gateway (discord). Message ID: p1",
      },
    ];

    for (const testCase of cases) {
      expect(formatGatewaySummary(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const discordConfig = {
  channels: {
    discord: {},
  },
} as OpenClawConfig;

describe("outbound policy", () => {
  beforeEach(() => {
    setDefaultChannelPluginRegistryForTests();
  });

  it("allows cross-provider sends when enabled", () => {
    const cfg = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowAcrossProviders: true } },
      },
    } as OpenClawConfig;

    expect(() =>
      enforceCrossContextPolicy({
        cfg,
        channel: "telegram",
        action: "send",
        args: { to: "telegram:@ops" },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      }),
    ).not.toThrow();
  });

  it("uses components when available and preferred", async () => {
    const decoration = await buildCrossContextDecoration({
      cfg: discordConfig,
      channel: "discord",
      target: "123",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "discord" },
    });

    expect(decoration).not.toBeNull();
    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: decoration!,
      preferComponents: true,
    });

    expect(applied.usedComponents).toBe(true);
    expect(applied.componentsBuilder).toBeDefined();
    expect(applied.componentsBuilder?.("hello").length).toBeGreaterThan(0);
    expect(applied.message).toBe("hello");
  });
});

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
      {
        name: "Slack user DM target",
        cfg: perChannelPeerCfg,
        channel: "slack",
        target: "user:U12345ABC",
        expected: {
          sessionKey: "agent:main:slack:direct:u12345abc",
          from: "slack:U12345ABC",
          to: "user:U12345ABC",
          chatType: "direct",
        },
      },
      {
        name: "Slack channel target without thread",
        cfg: baseConfig,
        channel: "slack",
        target: "channel:C999XYZ",
        expected: {
          sessionKey: "agent:main:slack:channel:c999xyz",
          from: "slack:channel:C999XYZ",
          to: "channel:C999XYZ",
          chatType: "channel",
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

describe("normalizeOutboundPayloadsForJson", () => {
  it("normalizes payloads for JSON output", () => {
    const cases = typedCases<{
      input: Parameters<typeof normalizeOutboundPayloadsForJson>[0];
      expected: ReturnType<typeof normalizeOutboundPayloadsForJson>;
    }>([
      {
        input: [
          { text: "hi" },
          { text: "photo", mediaUrl: "https://x.test/a.jpg", audioAsVoice: true },
          { text: "multi", mediaUrls: ["https://x.test/1.png"] },
        ],
        expected: [
          {
            text: "hi",
            mediaUrl: null,
            mediaUrls: undefined,
            audioAsVoice: undefined,
            channelData: undefined,
          },
          {
            text: "photo",
            mediaUrl: "https://x.test/a.jpg",
            mediaUrls: ["https://x.test/a.jpg"],
            audioAsVoice: true,
            channelData: undefined,
          },
          {
            text: "multi",
            mediaUrl: null,
            mediaUrls: ["https://x.test/1.png"],
            audioAsVoice: undefined,
            channelData: undefined,
          },
        ],
      },
      {
        input: [
          {
            text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
          },
        ],
        expected: [
          {
            text: "",
            mediaUrl: null,
            mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
            audioAsVoice: undefined,
            channelData: undefined,
          },
        ],
      },
    ]);

    for (const testCase of cases) {
      const input: ReplyPayload[] = testCase.input.map((payload) =>
        "mediaUrls" in payload
          ? ({
              ...payload,
              mediaUrls: payload.mediaUrls ? [...payload.mediaUrls] : undefined,
            } as ReplyPayload)
          : ({ ...payload } as ReplyPayload),
      );
      expect(normalizeOutboundPayloadsForJson(input)).toEqual(testCase.expected);
    }
  });

  it("suppresses reasoning payloads", () => {
    const normalized = normalizeOutboundPayloadsForJson([
      { text: "Reasoning:\n_step_", isReasoning: true },
      { text: "final answer" },
    ]);
    expect(normalized).toEqual([
      { text: "final answer", mediaUrl: null, mediaUrls: undefined, audioAsVoice: undefined },
    ]);
  });
});

describe("normalizeOutboundPayloads", () => {
  it("keeps channelData-only payloads", () => {
    const channelData = { line: { flexMessage: { altText: "Card", contents: {} } } };
    const normalized = normalizeOutboundPayloads([{ channelData }]);
    expect(normalized).toEqual([{ text: "", mediaUrls: [], channelData }]);
  });

  it("suppresses reasoning payloads", () => {
    const normalized = normalizeOutboundPayloads([
      { text: "Reasoning:\n_step_", isReasoning: true },
      { text: "final answer" },
    ]);
    expect(normalized).toEqual([{ text: "final answer", mediaUrls: [] }]);
  });

  it("formats BTW replies prominently for external delivery", () => {
    const normalized = normalizeOutboundPayloads([
      {
        text: "323",
        btw: { question: "what is 17 * 19?" },
      },
    ]);
    expect(normalized).toEqual([{ text: "BTW\nQuestion: what is 17 * 19?\n\n323", mediaUrls: [] }]);
  });
});

describe("formatOutboundPayloadLog", () => {
  it("formats text+media and media-only logs", () => {
    const cases = typedCases<{
      name: string;
      input: Parameters<typeof formatOutboundPayloadLog>[0];
      expected: string;
    }>([
      {
        name: "text with media lines",
        input: {
          text: "hello  ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        },
        expected: "hello\nMEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
      },
      {
        name: "media only",
        input: {
          text: "",
          mediaUrls: ["https://x.test/a.png"],
        },
        expected: "MEDIA:https://x.test/a.png",
      },
    ]);

    for (const testCase of cases) {
      expect(
        formatOutboundPayloadLog({
          ...testCase.input,
          mediaUrls: [...testCase.input.mediaUrls],
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });
});

runResolveOutboundTargetCoreTests();
