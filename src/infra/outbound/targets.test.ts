import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";

runResolveOutboundTargetCoreTests();

describe("resolveOutboundTarget defaultTo config fallback", () => {
  installResolveOutboundTargetPluginRegistryHooks();

  it("uses whatsapp defaultTo when no explicit target is provided", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { defaultTo: "+15551234567", allowFrom: ["*"] } },
    };
    const res = resolveOutboundTarget({
      channel: "whatsapp",
      to: undefined,
      cfg,
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
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { defaultTo: "+15551234567", allowFrom: ["*"] } },
    };
    const res = resolveOutboundTarget({
      channel: "whatsapp",
      to: "+15559999999",
      cfg,
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

    expect(resolved).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
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

    expect(resolved).toEqual({
      channel: "telegram",
      to: "+1555",
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
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

    expect(resolved).toEqual({
      channel: "slack",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("parses :topic:NNN from explicitTo into threadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-topic",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
    });

    expect(resolved.to).toBe("63448508");
    expect(resolved.threadId).toBe(1008013);
  });

  it("parses :topic:NNN even when lastTo is absent", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-no-last",
        updatedAt: 1,
        lastChannel: "telegram",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
    });

    expect(resolved.to).toBe("63448508");
    expect(resolved.threadId).toBe(1008013);
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

  it("allows heartbeat delivery to Slack DMs and avoids inherited threadId by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-outbound",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("slack");
    expect(resolved.to).toBe("user:U123");
    expect(resolved.threadId).toBeUndefined();
  });

  it("blocks heartbeat delivery to Slack DMs when directPolicy is block", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-outbound",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      heartbeat: {
        target: "last",
        directPolicy: "block",
      },
    });

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
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-telegram-direct",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "5232990709",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("5232990709");
  });

  it("blocks heartbeat delivery to Telegram direct chats when directPolicy is block", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-telegram-direct",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "5232990709",
      },
      heartbeat: {
        target: "last",
        directPolicy: "block",
      },
    });

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
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-imessage-direct",
        updatedAt: 1,
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("imessage");
    expect(resolved.to).toBe("chat-guid-unknown-shape");
  });

  it("blocks session chatType direct hints when directPolicy is block", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-imessage-direct",
        updatedAt: 1,
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      heartbeat: {
        target: "last",
        directPolicy: "block",
      },
    });

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
