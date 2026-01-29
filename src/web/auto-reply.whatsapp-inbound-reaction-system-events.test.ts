import "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import {
  drainSystemEvents,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { monitorWebChannel } from "./auto-reply.js";
import type { WebInboundReaction } from "./inbound.js";
import { resetBaileysMocks, resetLoadConfigMock, setLoadConfigMock } from "./test-helpers.js";

let previousHome: string | undefined;
let tempHome: string | undefined;

beforeEach(async () => {
  resetInboundDedupe();
  resetSystemEventsForTest();
  previousHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-web-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = previousHome;
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = undefined;
  }
});

describe("web auto-reply – inbound reaction system events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("enqueues a system event when a reaction is received", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {},
    }));

    let capturedOnReaction: ((reaction: WebInboundReaction) => void) | undefined;
    const listenerFactory = async (opts: {
      onMessage: (...args: unknown[]) => Promise<void>;
      onReaction?: (reaction: WebInboundReaction) => void;
    }) => {
      capturedOnReaction = opts.onReaction;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false);
    expect(capturedOnReaction).toBeDefined();

    const cfg = { channels: { whatsapp: { allowFrom: ["*"] } }, messages: {} };
    const route = resolveAgentRoute({
      cfg: cfg as Parameters<typeof resolveAgentRoute>[0]["cfg"],
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "dm", id: "999@s.whatsapp.net" },
    });

    // Drain the "WhatsApp gateway connected" event so we only check reaction events
    drainSystemEvents(route.sessionKey);

    capturedOnReaction!({
      messageId: "msg-abc",
      emoji: "👍",
      chatJid: "999@s.whatsapp.net",
      chatType: "direct",
      accountId: "default",
      senderJid: "999@s.whatsapp.net",
      senderE164: "+999",
      timestamp: Date.now(),
    });

    const events = peekSystemEvents(route.sessionKey);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("WhatsApp reaction added: 👍 by +999 msg msg-abc");
  });

  it("uses senderJid when senderE164 is unavailable", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {},
    }));

    let capturedOnReaction: ((reaction: WebInboundReaction) => void) | undefined;
    const listenerFactory = async (opts: {
      onMessage: (...args: unknown[]) => Promise<void>;
      onReaction?: (reaction: WebInboundReaction) => void;
    }) => {
      capturedOnReaction = opts.onReaction;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false);

    const cfg = { channels: { whatsapp: { allowFrom: ["*"] } }, messages: {} };
    const route = resolveAgentRoute({
      cfg: cfg as Parameters<typeof resolveAgentRoute>[0]["cfg"],
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "dm", id: "999@s.whatsapp.net" },
    });

    drainSystemEvents(route.sessionKey);

    capturedOnReaction!({
      messageId: "msg-xyz",
      emoji: "❤️",
      chatJid: "999@s.whatsapp.net",
      chatType: "direct",
      accountId: "default",
      senderJid: "999@s.whatsapp.net",
      timestamp: Date.now(),
    });

    const events = peekSystemEvents(route.sessionKey);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("WhatsApp reaction added: ❤️ by 999@s.whatsapp.net msg msg-xyz");
  });

  it("falls back to 'someone' when no sender info available", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {},
    }));

    let capturedOnReaction: ((reaction: WebInboundReaction) => void) | undefined;
    const listenerFactory = async (opts: {
      onMessage: (...args: unknown[]) => Promise<void>;
      onReaction?: (reaction: WebInboundReaction) => void;
    }) => {
      capturedOnReaction = opts.onReaction;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false);

    const cfg = { channels: { whatsapp: { allowFrom: ["*"] } }, messages: {} };
    const route = resolveAgentRoute({
      cfg: cfg as Parameters<typeof resolveAgentRoute>[0]["cfg"],
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "dm", id: "999@s.whatsapp.net" },
    });

    drainSystemEvents(route.sessionKey);

    capturedOnReaction!({
      messageId: "msg-noid",
      emoji: "🔥",
      chatJid: "999@s.whatsapp.net",
      chatType: "direct",
      accountId: "default",
      timestamp: Date.now(),
    });

    const events = peekSystemEvents(route.sessionKey);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("WhatsApp reaction added: 🔥 by someone msg msg-noid");
  });

  it("normalizes DM reaction peer ID to E.164 matching message routing", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {},
      session: { dmScope: "per-peer" },
    }));

    let capturedOnReaction: ((reaction: WebInboundReaction) => void) | undefined;
    const listenerFactory = async (opts: {
      onMessage: (...args: unknown[]) => Promise<void>;
      onReaction?: (reaction: WebInboundReaction) => void;
    }) => {
      capturedOnReaction = opts.onReaction;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false);

    const cfg = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {},
      session: { dmScope: "per-peer" },
    };

    // For DM reactions with senderE164, the peer ID should be normalized to E.164
    // to match how messages are routed (via resolvePeerId).
    const normalizedRoute = resolveAgentRoute({
      cfg: cfg as Parameters<typeof resolveAgentRoute>[0]["cfg"],
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "dm", id: "+19995551234" },
    });

    // Drain both potential session keys to clear "gateway connected" events
    drainSystemEvents(normalizedRoute.sessionKey);
    const jidRoute = resolveAgentRoute({
      cfg: cfg as Parameters<typeof resolveAgentRoute>[0]["cfg"],
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "dm", id: "19995551234@s.whatsapp.net" },
    });
    drainSystemEvents(jidRoute.sessionKey);

    capturedOnReaction!({
      messageId: "msg-normalized",
      emoji: "✅",
      chatJid: "19995551234@s.whatsapp.net",
      chatType: "direct",
      accountId: "default",
      senderJid: "19995551234@s.whatsapp.net",
      senderE164: "+19995551234",
      timestamp: Date.now(),
    });

    // The reaction should land in the E.164-normalized session, not the JID-based one.
    const events = peekSystemEvents(normalizedRoute.sessionKey);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("WhatsApp reaction added: ✅ by +19995551234 msg msg-normalized");

    // Verify it did NOT land in a JID-based session key.
    const jidEvents = peekSystemEvents(jidRoute.sessionKey);
    expect(jidEvents).toHaveLength(0);
  });
});
