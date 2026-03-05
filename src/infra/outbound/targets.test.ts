import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionRouteDecision,
  resolveHeartbeatDeliveryTarget,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";

runResolveOutboundTargetCoreTests();

describe("resolveSessionDeliveryTarget main-session fail-closed mode", () => {
  const sessionEntry = {
    sessionId: "sess-main",
    updatedAt: 1,
    deliveryContext: {
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
      threadId: 11,
    },
    lastChannel: "telegram",
    lastTo: "telegram:123",
    lastAccountId: "default",
    lastThreadId: 11,
  } as const;

  it("fails closed for main-session aliases when enabled", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "main",
      failClosedMainSessionLastRoute: true,
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        channel: undefined,
        to: undefined,
        accountId: undefined,
        threadId: undefined,
        lastChannel: undefined,
        lastTo: undefined,
        lastAccountId: undefined,
        lastThreadId: undefined,
      }),
    );
  });

  it("keeps default main-session route inheritance when fail-closed mode is disabled", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "main",
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:123",
        accountId: "default",
        threadId: 11,
      }),
    );
  });

  it("inherits route metadata for non-main channel-scoped sessions", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:telegram:direct:123",
      failClosedMainSessionLastRoute: true,
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:123",
        accountId: "default",
        threadId: 11,
      }),
    );
  });

  it("fails closed for channel-agnostic non-main sessions when enabled", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:direct:peer-123",
      failClosedMainSessionLastRoute: true,
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        channel: undefined,
        to: undefined,
        accountId: undefined,
        threadId: undefined,
      }),
    );
  });

  it("treats configured mainKey aliases as main sessions", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:work",
      mainKey: "work",
      failClosedMainSessionLastRoute: true,
    });
    expect(resolved.channel).toBeUndefined();
    expect(resolved.to).toBeUndefined();
  });

  it("treats threaded main sessions as main aliases", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:main:thread:2026-03-04",
      failClosedMainSessionLastRoute: true,
    });
    expect(resolved.channel).toBeUndefined();
    expect(resolved.to).toBeUndefined();
  });

  it("inherits route metadata for threaded channel-scoped sessions", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:telegram:direct:123:thread:2026-03-04",
      failClosedMainSessionLastRoute: true,
    });
    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("telegram:123");
  });

  it("uses turn-source metadata over fail-closed main-session defaults", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "main",
      failClosedMainSessionLastRoute: true,
      turnSourceChannel: "discord",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "bot-1",
      turnSourceThreadId: "thread-9",
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C123",
        accountId: "bot-1",
        threadId: "thread-9",
      }),
    );
  });
});

describe("resolveSessionRouteDecision", () => {
  const sessionEntry = {
    sessionId: "sess-main",
    updatedAt: 1,
    deliveryContext: {
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
      threadId: 11,
    },
    lastChannel: "telegram",
    lastTo: "telegram:123",
    lastAccountId: "default",
    lastThreadId: 11,
  } as const;

  it("returns blocked for fail-closed main alias with no explicit origin", () => {
    const decision = resolveSessionRouteDecision({
      intent: "external_preferred",
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "main",
      failClosedMainSessionLastRoute: true,
    });
    expect(decision).toEqual({
      status: "blocked",
      reason: "main_alias_blocked",
      target: undefined,
    });
  });

  it("returns missing when turn-source channel is provided without turn-source recipient", () => {
    const decision = resolveSessionRouteDecision({
      intent: "external_preferred",
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "main",
      failClosedMainSessionLastRoute: true,
      turnSourceChannel: "telegram",
    });
    expect(decision).toEqual({
      status: "missing",
      reason: "missing_turn_source_to",
      target: undefined,
    });
  });

  it("returns resolved for channel-scoped session inheritance", () => {
    const decision = resolveSessionRouteDecision({
      intent: "external_preferred",
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:telegram:direct:123",
      failClosedMainSessionLastRoute: true,
    });
    expect(decision).toEqual({
      status: "resolved",
      reason: "ok",
      target: expect.objectContaining({
        channel: "telegram",
        to: "telegram:123",
        accountId: "default",
        threadId: 11,
      }),
    });
  });

  it("returns missing for channel-agnostic non-main sessions when fail-closed mode blocks inheritance", () => {
    const decision = resolveSessionRouteDecision({
      intent: "external_preferred",
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:direct:peer-123",
      failClosedMainSessionLastRoute: true,
    });
    expect(decision).toEqual({
      status: "missing",
      reason: "missing_to",
      target: undefined,
    });
  });

  it("returns blocked for internal-only intent even when route is available", () => {
    const decision = resolveSessionRouteDecision({
      intent: "internal_only",
      entry: sessionEntry,
      requestedChannel: "last",
      sessionKey: "agent:main:telegram:direct:123",
      failClosedMainSessionLastRoute: true,
    });
    expect(decision).toEqual({
      status: "blocked",
      reason: "internal_only",
      target: undefined,
    });
  });
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
});

describe("resolveSessionDeliveryTarget", () => {
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
    const resolved = resolveSessionDeliveryTarget({
      entry,
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
    });
    expect(resolved.to).toBe("63448508");
    expect(resolved.threadId).toBe(1008013);
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

  it("passes through explicitThreadId when provided", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-thread",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastThreadId: 999,
      },
      requestedChannel: "last",
      explicitThreadId: 42,
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
  });

  it("uses session lastThreadId when no explicitThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-thread-2",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastThreadId: 999,
      },
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBe(999);
  });

  it("does not inherit lastThreadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-heartbeat-thread",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      requestedChannel: "last",
      mode: "heartbeat",
    });

    expect(resolved.threadId).toBeUndefined();
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

  it("skips :topic: parsing for non-telegram channels", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-slack",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "C12345",
      },
      requestedChannel: "last",
      explicitTo: "C12345:topic:999",
    });

    expect(resolved.to).toBe("C12345:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("skips :topic: parsing when channel is explicitly non-telegram even if lastChannel was telegram", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-cross",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "slack",
      explicitTo: "C12345:topic:999",
    });

    expect(resolved.to).toBe("C12345:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("explicitThreadId takes priority over :topic: parsed value", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-priority",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
      explicitThreadId: 42,
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.to).toBe("63448508");
  });

  const resolveHeartbeatTarget = (
    entry: Parameters<typeof resolveHeartbeatDeliveryTarget>[0]["entry"],
    directPolicy?: "allow" | "block",
  ) =>
    resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry,
      heartbeat: {
        target: "last",
        ...(directPolicy ? { directPolicy } : {}),
      },
    });

  it("allows heartbeat delivery to Slack DMs and avoids inherited threadId by default", () => {
    const resolved = resolveHeartbeatTarget({
      sessionId: "sess-heartbeat-outbound",
      updatedAt: 1,
      lastChannel: "slack",
      lastTo: "user:U123",
      lastThreadId: "1739142736.000100",
    });

    expect(resolved.channel).toBe("slack");
    expect(resolved.to).toBe("user:U123");
    expect(resolved.threadId).toBeUndefined();
  });

  it("blocks heartbeat delivery to Slack DMs when directPolicy is block", () => {
    const resolved = resolveHeartbeatTarget(
      {
        sessionId: "sess-heartbeat-outbound",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      "block",
    );

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
    expect(resolved.threadId).toBeUndefined();
  });

  it("allows heartbeat delivery to Discord DMs by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-discord-dm",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "user:12345",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("discord");
    expect(resolved.to).toBe("user:12345");
  });

  it("allows heartbeat delivery to Telegram direct chats by default", () => {
    const resolved = resolveHeartbeatTarget({
      sessionId: "sess-heartbeat-telegram-direct",
      updatedAt: 1,
      lastChannel: "telegram",
      lastTo: "5232990709",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("5232990709");
  });

  it("blocks heartbeat delivery to Telegram direct chats when directPolicy is block", () => {
    const resolved = resolveHeartbeatTarget(
      {
        sessionId: "sess-heartbeat-telegram-direct",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "5232990709",
      },
      "block",
    );

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("keeps heartbeat delivery to Telegram groups", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-telegram-group",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-1001234567890",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1001234567890");
  });

  it("allows heartbeat delivery to WhatsApp direct chats by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-whatsapp-direct",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+15551234567",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("+15551234567");
  });

  it("keeps heartbeat delivery to WhatsApp groups", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-whatsapp-group",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "120363140186826074@g.us",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("120363140186826074@g.us");
  });

  it("uses session chatType hint when target parser cannot classify and allows direct by default", () => {
    const resolved = resolveHeartbeatTarget({
      sessionId: "sess-heartbeat-imessage-direct",
      updatedAt: 1,
      lastChannel: "imessage",
      lastTo: "chat-guid-unknown-shape",
      chatType: "direct",
    });

    expect(resolved.channel).toBe("imessage");
    expect(resolved.to).toBe("chat-guid-unknown-shape");
  });

  it("blocks session chatType direct hints when directPolicy is block", () => {
    const resolved = resolveHeartbeatTarget(
      {
        sessionId: "sess-heartbeat-imessage-direct",
        updatedAt: 1,
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      "block",
    );

    expect(resolved.channel).toBe("none");
    expect(resolved.reason).toBe("dm-blocked");
  });

  it("keeps heartbeat delivery to Discord channels", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-discord-channel",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "channel:999",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("discord");
    expect(resolved.to).toBe("channel:999");
  });

  it("keeps explicit threadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
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
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
    expect(resolved.threadId).toBe(42);
    expect(resolved.threadIdExplicit).toBe(true);
  });

  it("parses explicit heartbeat topic targets into threadId", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      heartbeat: {
        target: "telegram",
        to: "-10063448508:topic:1008013",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-10063448508");
    expect(resolved.threadId).toBe(1008013);
  });
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  it("uses turnSourceChannel over session lastChannel when provided", () => {
    // Simulate: WhatsApp message originated the turn, but a Slack message
    // arrived concurrently and updated lastChannel to "slack"
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-shared",
        updatedAt: 1,
        lastChannel: "slack", // <- concurrently overwritten
        lastTo: "U0AEMECNCBV", // <- Slack user (wrong target)
      },
      requestedChannel: "last",
      turnSourceChannel: "whatsapp", // <- originated from WhatsApp
      turnSourceTo: "+66972796305", // <- WhatsApp user (correct target)
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("+66972796305");
  });

  it("falls back to session lastChannel when turnSourceChannel is not set", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-normal",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "8587265585",
      },
      requestedChannel: "last",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("8587265585");
  });

  it("respects explicit requestedChannel over turnSourceChannel", () => {
    const resolved = resolveSessionDeliveryTarget({
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
    });

    // Explicit requestedChannel "telegram" is not "last", so it takes priority
    expect(resolved.channel).toBe("telegram");
  });

  it("preserves turnSourceAccountId and turnSourceThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
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
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("8587265585");
    expect(resolved.accountId).toBe("bot-123");
    expect(resolved.threadId).toBe(42);
  });

  it("does not fall back to session target metadata when turnSourceChannel is set", () => {
    const resolved = resolveSessionDeliveryTarget({
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
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBeUndefined();
    expect(resolved.accountId).toBeUndefined();
    expect(resolved.threadId).toBeUndefined();
    expect(resolved.lastTo).toBeUndefined();
    expect(resolved.lastAccountId).toBeUndefined();
    expect(resolved.lastThreadId).toBeUndefined();
  });

  it("uses explicitTo even when turnSourceTo is omitted", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-explicit-to",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "U_WRONG",
      },
      requestedChannel: "last",
      explicitTo: "+15551234567",
      turnSourceChannel: "whatsapp",
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("+15551234567");
  });

  it("still allows mismatched lastTo only from turn-scoped metadata", () => {
    const resolved = resolveSessionDeliveryTarget({
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
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("+15550000000");
  });
});
