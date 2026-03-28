import { beforeEach, describe, expect, it } from "vitest";
import { telegramOutbound, whatsappOutbound } from "../../../test/channel-outbounds.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../plugin-sdk/whatsapp-targets.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";
import { telegramMessagingForTest } from "./targets.test-helpers.js";

runResolveOutboundTargetCoreTests();

const whatsappMessaging = {
  inferTargetChatType: ({ to }: { to: string }) => {
    const normalized = normalizeWhatsAppTarget(to);
    if (!normalized) {
      return undefined;
    }
    return isWhatsAppGroupJid(normalized) ? ("group" as const) : ("direct" as const);
  },
};

const noopOutbound = (channel: "discord" | "imessage" | "slack"): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async () => ({ channel, messageId: `${channel}-msg` }),
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createOutboundTestPlugin({ id: "discord", outbound: noopOutbound("discord") }),
        source: "test",
      },
      {
        pluginId: "imessage",
        plugin: createOutboundTestPlugin({ id: "imessage", outbound: noopOutbound("imessage") }),
        source: "test",
      },
      {
        pluginId: "slack",
        plugin: createOutboundTestPlugin({ id: "slack", outbound: noopOutbound("slack") }),
        source: "test",
      },
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: telegramOutbound,
          messaging: telegramMessagingForTest,
        }),
        source: "test",
      },
      {
        pluginId: "whatsapp",
        plugin: createOutboundTestPlugin({
          id: "whatsapp",
          outbound: whatsappOutbound,
          messaging: whatsappMessaging,
        }),
        source: "test",
      },
    ]),
  );
});

describe("resolveOutboundTarget defaultTo config fallback", () => {
  installResolveOutboundTargetPluginRegistryHooks();
  const whatsappDefaultCfg: OpenClawConfig = {
    channels: { whatsapp: { defaultTo: "+15551234567", allowFrom: ["*"] } },
  };

  it("uses whatsapp defaultTo when no explicit target is provided", () => {
    const res = resolveOutboundTarget({
      channel: "whatsapp",
      to: undefined,
      cfg: whatsappDefaultCfg,
      mode: "implicit",
    });
    expect(res).toEqual({ ok: true, to: "+15551234567" });
  });

  it("uses telegram defaultTo when no explicit target is provided", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { defaultTo: "123456789" } },
    };
    const res = resolveOutboundTarget({
      channel: "telegram",
      to: "",
      cfg,
      mode: "implicit",
    });
    expect(res).toEqual({ ok: true, to: "123456789" });
  });

  it("explicit --reply-to overrides defaultTo", () => {
    const res = resolveOutboundTarget({
      channel: "whatsapp",
      to: "+15559999999",
      cfg: whatsappDefaultCfg,
      mode: "explicit",
    });
    expect(res).toEqual({ ok: true, to: "+15559999999" });
  });

  it("still errors when no defaultTo and no explicit target", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["+1555"] } },
    };
    const res = resolveOutboundTarget({
      channel: "whatsapp",
      to: "",
      cfg,
      mode: "implicit",
    });
    expect(res.ok).toBe(false);
  });

  it("falls back to the active registry when the cached channel map is stale", () => {
    const registry = createTestRegistry([]);
    setActivePluginRegistry(registry, "stale-registry-test");

    // Warm the cached channel map before mutating the registry in place.
    expect(resolveOutboundTarget({ channel: "telegram", to: "123", mode: "explicit" }).ok).toBe(
      false,
    );

    registry.channels.push({
      pluginId: "telegram",
      plugin: createOutboundTestPlugin({
        id: "telegram",
        outbound: telegramOutbound,
        messaging: telegramMessagingForTest,
      }),
      source: "test",
    });

    expect(resolveOutboundTarget({ channel: "telegram", to: "123", mode: "explicit" })).toEqual({
      ok: true,
      to: "123",
    });
  });
});

describe("resolveSessionDeliveryTarget", () => {
  type SessionDeliveryRequest = Parameters<typeof resolveSessionDeliveryTarget>[0];
  type HeartbeatDeliveryRequest = Parameters<typeof resolveHeartbeatDeliveryTarget>[0];

  const expectImplicitRoute = (
    resolved: SessionDeliveryTarget,
    params: {
      channel?: SessionDeliveryTarget["channel"];
      to?: string;
      lastChannel?: SessionDeliveryTarget["lastChannel"];
      lastTo?: string;
    },
  ) => {
    expect(resolved).toEqual({
      channel: params.channel,
      to: params.to,
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: params.lastChannel,
      lastTo: params.lastTo,
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  };

  const expectTopicParsedFromExplicitTo = (
    entry: Parameters<typeof resolveSessionDeliveryTarget>[0]["entry"],
  ) => {
    expectResolvedSessionTarget({
      request: {
        entry,
        requestedChannel: "last",
        explicitTo: "63448508:topic:1008013",
      },
      expected: {
        to: "63448508",
        threadId: 1008013,
      },
    });
  };

  const expectResolvedSessionTarget = (params: {
    request: SessionDeliveryRequest;
    expected: Partial<SessionDeliveryTarget>;
  }) => {
    expect(resolveSessionDeliveryTarget(params.request)).toMatchObject(params.expected);
  };

  const expectResolvedHeartbeatRoute = (params: {
    request: HeartbeatDeliveryRequest;
    expected: Partial<ReturnType<typeof resolveHeartbeatDeliveryTarget>>;
  }) => {
    expect(resolveHeartbeatDeliveryTarget(params.request)).toMatchObject(params.expected);
  };

  it("derives implicit delivery from the last route", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        lastChannel: " whatsapp ",
        lastTo: " +1555 ",
        lastAccountId: " acct-1 ",
      },
      requestedChannel: "last",
    });

    expect(resolved).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "acct-1",
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: "acct-1",
      lastThreadId: undefined,
    });
  });

  it("prefers explicit targets without reusing lastTo", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-2",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "telegram",
    });

    expectImplicitRoute(resolved, {
      channel: "telegram",
      to: undefined,
      lastChannel: "whatsapp",
      lastTo: "+1555",
    });
  });

  it("allows mismatched lastTo when configured", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-3",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "telegram",
      allowMismatchedLastTo: true,
    });

    expectImplicitRoute(resolved, {
      channel: "telegram",
      to: "+1555",
      lastChannel: "whatsapp",
      lastTo: "+1555",
    });
  });

  it.each([
    {
      name: "passes through explicitThreadId when provided",
      request: {
        entry: {
          sessionId: "sess-thread",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "-100123",
          lastThreadId: 999,
        },
        requestedChannel: "last",
        explicitThreadId: 42,
      },
      expected: {
        channel: "telegram",
        to: "-100123",
        threadId: 42,
      },
    },
    {
      name: "uses session lastThreadId when no explicitThreadId",
      request: {
        entry: {
          sessionId: "sess-thread-2",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "-100123",
          lastThreadId: 999,
        },
        requestedChannel: "last",
      },
      expected: {
        threadId: 999,
      },
    },
    {
      name: "does not inherit lastThreadId in heartbeat mode",
      request: {
        entry: {
          sessionId: "sess-heartbeat-thread",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "user:U123",
          lastThreadId: "1739142736.000100",
        },
        requestedChannel: "last",
        mode: "heartbeat",
      },
      expected: {
        threadId: undefined,
      },
    },
  ] satisfies Array<{
    name: string;
    request: SessionDeliveryRequest;
    expected: Partial<SessionDeliveryTarget>;
  }>)("$name", ({ request, expected }) => {
    expectResolvedSessionTarget({ request, expected });
  });

  it("falls back to a provided channel when requested is unsupported", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-4",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "webchat",
      fallbackChannel: "slack",
    });

    expectImplicitRoute(resolved, {
      channel: "slack",
      to: undefined,
      lastChannel: "whatsapp",
      lastTo: "+1555",
    });
  });

  it("parses :topic:NNN from explicitTo into threadId", () => {
    expectTopicParsedFromExplicitTo({
      sessionId: "sess-topic",
      updatedAt: 1,
      lastChannel: "telegram",
      lastTo: "63448508",
    });
  });

  it("parses :topic:NNN even when lastTo is absent", () => {
    expectTopicParsedFromExplicitTo({
      sessionId: "sess-no-last",
      updatedAt: 1,
      lastChannel: "telegram",
    });
  });

  it.each([
    {
      name: "skips :topic: parsing for non-telegram channels",
      request: {
        entry: {
          sessionId: "sess-slack",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "C12345",
        },
        requestedChannel: "last",
        explicitTo: "C12345:topic:999",
      },
    },
    {
      name: "skips :topic: parsing when channel is explicitly non-telegram even if lastChannel was telegram",
      request: {
        entry: {
          sessionId: "sess-cross",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "63448508",
        },
        requestedChannel: "slack",
        explicitTo: "C12345:topic:999",
      },
    },
  ] satisfies Array<{
    name: string;
    request: SessionDeliveryRequest;
  }>)("$name", ({ request }) => {
    expectResolvedSessionTarget({
      request,
      expected: {
        to: "C12345:topic:999",
        threadId: undefined,
      },
    });
  });

  it("keeps raw :topic: targets when the telegram plugin registry is unavailable", () => {
    setActivePluginRegistry(createTestRegistry([]));

    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-no-registry",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
    });

    expect(resolved.to).toBe("63448508:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
  });

  it("explicitThreadId takes priority over :topic: parsed value", () => {
    expectResolvedSessionTarget({
      request: {
        entry: {
          sessionId: "sess-priority",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "63448508",
        },
        requestedChannel: "last",
        explicitTo: "63448508:topic:1008013",
        explicitThreadId: 42,
      },
      expected: {
        threadId: 42,
        to: "63448508",
      },
    });
  });

  const resolveHeartbeatTarget = (entry: SessionEntry, directPolicy?: "allow" | "block") =>
    resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry,
      heartbeat: {
        target: "last",
        ...(directPolicy ? { directPolicy } : {}),
      },
    });

  const expectHeartbeatTarget = (params: {
    name: string;
    entry: SessionEntry;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
    expectedThreadId?: string | number;
  }) => {
    const resolved = resolveHeartbeatTarget(params.entry, params.directPolicy);
    expect(resolved.channel, params.name).toBe(params.expectedChannel);
    expect(resolved.to, params.name).toBe(params.expectedTo);
    expect(resolved.reason, params.name).toBe(params.expectedReason);
    expect(resolved.threadId, params.name).toBe(params.expectedThreadId);
  };

  it.each([
    {
      name: "allows heartbeat delivery to Slack DMs by default and drops inherited thread ids",
      entry: {
        sessionId: "sess-heartbeat-slack-direct",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      expectedChannel: "slack",
      expectedTo: "user:U123",
    },
    {
      name: "blocks heartbeat delivery to Slack DMs when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-slack-direct-blocked",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
    {
      name: "allows heartbeat delivery to Telegram direct chats by default",
      entry: {
        sessionId: "sess-heartbeat-telegram-direct",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "5232990709",
      },
      expectedChannel: "telegram",
      expectedTo: "5232990709",
    },
    {
      name: "blocks heartbeat delivery to Telegram direct chats when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-telegram-direct-blocked",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "5232990709",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
    {
      name: "keeps heartbeat delivery to Telegram groups",
      entry: {
        sessionId: "sess-heartbeat-telegram-group",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-1001234567890",
      },
      expectedChannel: "telegram",
      expectedTo: "-1001234567890",
    },
    {
      name: "allows heartbeat delivery to WhatsApp direct chats by default",
      entry: {
        sessionId: "sess-heartbeat-whatsapp-direct",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+15551234567",
      },
      expectedChannel: "whatsapp",
      expectedTo: "+15551234567",
    },
    {
      name: "keeps heartbeat delivery to WhatsApp groups",
      entry: {
        sessionId: "sess-heartbeat-whatsapp-group",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "120363140186826074@g.us",
      },
      expectedChannel: "whatsapp",
      expectedTo: "120363140186826074@g.us",
    },
    {
      name: "uses session chatType hints when target parsing cannot classify a direct chat",
      entry: {
        sessionId: "sess-heartbeat-imessage-direct",
        updatedAt: 1,
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      expectedChannel: "imessage",
      expectedTo: "chat-guid-unknown-shape",
    },
    {
      name: "blocks session chatType direct hints when directPolicy is block",
      entry: {
        sessionId: "sess-heartbeat-imessage-direct-blocked",
        updatedAt: 1,
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      directPolicy: "block" as const,
      expectedChannel: "none",
      expectedReason: "dm-blocked",
    },
  ] satisfies Array<{
    name: string;
    entry: NonNullable<Parameters<typeof resolveHeartbeatDeliveryTarget>[0]["entry"]>;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
  }>)("$name", ({ name, entry, directPolicy, expectedChannel, expectedTo, expectedReason }) => {
    expectHeartbeatTarget({
      name,
      entry,
      directPolicy,
      expectedChannel,
      expectedTo,
      expectedReason,
    });
  });

  it.each([
    {
      name: "allows heartbeat delivery to Discord DMs by default",
      request: {
        cfg: {} as OpenClawConfig,
        entry: {
          sessionId: "sess-heartbeat-discord-dm",
          updatedAt: 1,
          lastChannel: "discord",
          lastTo: "user:12345",
        },
        heartbeat: {
          target: "last",
        },
      },
      expected: {
        channel: "discord",
        to: "user:12345",
      },
    },
    {
      name: "keeps heartbeat delivery to Discord channels",
      request: {
        cfg: {} as OpenClawConfig,
        entry: {
          sessionId: "sess-heartbeat-discord-channel",
          updatedAt: 1,
          lastChannel: "discord",
          lastTo: "channel:999",
        },
        heartbeat: {
          target: "last",
        },
      },
      expected: {
        channel: "discord",
        to: "channel:999",
      },
    },
    {
      name: "parses explicit heartbeat topic targets into threadId",
      request: {
        cfg: {} as OpenClawConfig,
        heartbeat: {
          target: "telegram",
          to: "-10063448508:topic:1008013",
        },
      },
      expected: {
        channel: "telegram",
        to: "-10063448508",
        threadId: 1008013,
      },
    },
    {
      name: "prefers turn-scoped routing over mutable session routing for target=last",
      request: {
        cfg: {},
        entry: {
          sessionId: "sess-heartbeat-turn-source",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U_WRONG",
        },
        heartbeat: {
          target: "last",
        },
        turnSource: {
          channel: "telegram",
          to: "-100123",
          threadId: 42,
        },
      },
      expected: {
        channel: "telegram",
        to: "-100123",
        threadId: 42,
      },
    },
    {
      name: "merges partial turn-scoped metadata with the stored session route for target=last",
      request: {
        cfg: {},
        entry: {
          sessionId: "sess-heartbeat-turn-source-partial",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "-100123",
        },
        heartbeat: {
          target: "last",
        },
        turnSource: {
          threadId: 42,
        },
      },
      expected: {
        channel: "telegram",
        to: "-100123",
        threadId: 42,
      },
    },
  ] satisfies Array<{
    name: string;
    request: HeartbeatDeliveryRequest;
    expected: Partial<ReturnType<typeof resolveHeartbeatDeliveryTarget>>;
  }>)("$name", ({ request, expected }) => {
    expectResolvedHeartbeatRoute({ request, expected });
  });

  it("keeps explicit threadId in heartbeat mode", () => {
    expectResolvedSessionTarget({
      request: {
        entry: {
          sessionId: "sess-heartbeat-explicit-thread",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "-100123",
          lastThreadId: 999,
        },
        requestedChannel: "last",
        mode: "heartbeat",
        explicitThreadId: 42,
      },
      expected: {
        channel: "telegram",
        to: "-100123",
        threadId: 42,
        threadIdExplicit: true,
      },
    });
  });
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  const expectCrossChannelReplyGuard = (params: {
    request: Parameters<typeof resolveSessionDeliveryTarget>[0];
    expected: Partial<SessionDeliveryTarget>;
  }) => {
    expect(resolveSessionDeliveryTarget(params.request)).toMatchObject(params.expected);
  };

  it.each([
    {
      name: "uses turnSourceChannel over session lastChannel when provided",
      request: {
        entry: {
          sessionId: "sess-shared",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U0AEMECNCBV",
        },
        requestedChannel: "last",
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+66972796305",
      },
      expected: {
        channel: "whatsapp",
        to: "+66972796305",
      },
    },
    {
      name: "falls back to session lastChannel when turnSourceChannel is not set",
      request: {
        entry: {
          sessionId: "sess-normal",
          updatedAt: 1,
          lastChannel: "telegram",
          lastTo: "8587265585",
        },
        requestedChannel: "last",
      },
      expected: {
        channel: "telegram",
        to: "8587265585",
      },
    },
    {
      name: "respects explicit requestedChannel over turnSourceChannel",
      request: {
        entry: {
          sessionId: "sess-explicit",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U12345",
        },
        requestedChannel: "telegram",
        explicitTo: "8587265585",
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+66972796305",
      },
      expected: {
        channel: "telegram",
      },
    },
    {
      name: "preserves turnSourceAccountId and turnSourceThreadId",
      request: {
        entry: {
          sessionId: "sess-meta",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U_WRONG",
          lastAccountId: "wrong-account",
        },
        requestedChannel: "last",
        turnSourceChannel: "telegram",
        turnSourceTo: "8587265585",
        turnSourceAccountId: "bot-123",
        turnSourceThreadId: 42,
      },
      expected: {
        channel: "telegram",
        to: "8587265585",
        accountId: "bot-123",
        threadId: 42,
      },
    },
    {
      name: "does not fall back to session target metadata when turnSourceChannel is set",
      request: {
        entry: {
          sessionId: "sess-no-fallback",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U_WRONG",
          lastAccountId: "wrong-account",
          lastThreadId: "1739142736.000100",
        },
        requestedChannel: "last",
        turnSourceChannel: "whatsapp",
      },
      expected: {
        channel: "whatsapp",
        to: undefined,
        accountId: undefined,
        threadId: undefined,
        lastTo: undefined,
        lastAccountId: undefined,
        lastThreadId: undefined,
      },
    },
    {
      name: "uses explicitTo even when turnSourceTo is omitted",
      request: {
        entry: {
          sessionId: "sess-explicit-to",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U_WRONG",
        },
        requestedChannel: "last",
        explicitTo: "+15551234567",
        turnSourceChannel: "whatsapp",
      },
      expected: {
        channel: "whatsapp",
        to: "+15551234567",
      },
    },
    {
      name: "still allows mismatched lastTo only from turn-scoped metadata",
      request: {
        entry: {
          sessionId: "sess-mismatch-turn",
          updatedAt: 1,
          lastChannel: "slack",
          lastTo: "U_WRONG",
        },
        requestedChannel: "telegram",
        allowMismatchedLastTo: true,
        turnSourceChannel: "whatsapp",
        turnSourceTo: "+15550000000",
      },
      expected: {
        channel: "telegram",
        to: "+15550000000",
      },
    },
  ] satisfies Array<{
    name: string;
    request: Parameters<typeof resolveSessionDeliveryTarget>[0];
    expected: Partial<SessionDeliveryTarget>;
  }>)("$name", ({ request, expected }) => {
    expectCrossChannelReplyGuard({ request, expected });
  });
});
