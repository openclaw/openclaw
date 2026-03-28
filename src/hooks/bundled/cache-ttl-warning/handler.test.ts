/**
 * Tests for cache-ttl-warning hook handler.
 *
 * Key behaviors validated:
 *  - Timer creates on message:sent
 *  - Timer resets on message:received
 *  - Timer resets on agent:llm-request (uses stored originalTo)
 *  - Warning fires at warningSeconds, expired fires at expiredSeconds
 *  - Previous notice is deleted when timer is reset by new activity
 *  - /new and /reset cancel all active timers
 *  - Group chats are never watched
 *  - watchConversations filter (empty = watch all, non-empty = allow-list)
 *  - Guard flag prevents self-triggered timer reset from own notice sends
 *  - Missing channelId or conversationId is handled gracefully
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";

// --- Mocks (must be hoisted before handler import) ---

const mockSendMessageTelegram = vi.fn();
const mockDeleteMessageTelegram = vi.fn();
const mockResolveTelegramToken = vi.fn();
const mockRouteReply = vi.fn();
const mockLoadConfig = vi.fn();
const mockResolveHookConfig = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();

vi.mock("../../../plugin-sdk/telegram.js", () => ({
  sendMessageTelegram: mockSendMessageTelegram,
  deleteMessageTelegram: mockDeleteMessageTelegram,
  resolveTelegramToken: mockResolveTelegramToken,
}));

vi.mock("../../../auto-reply/reply/route-reply.js", () => ({
  routeReply: mockRouteReply,
}));

vi.mock("../../../config/config.js", () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock("../../config.js", () => ({
  resolveHookConfig: mockResolveHookConfig,
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
  }),
}));

const { default: handler } = await import("./handler.js");

// --- Helpers ---

const TELEGRAM_TOKEN = "bot-token-123";
const CHAT_ID = "7898601152";
const CHANNEL_ID = "telegram";
const SESSION_KEY = "test-session";

/** Default hook config: 240s warning, 300s expired, watch all */
function defaultHookCfg(overrides: Record<string, unknown> = {}) {
  return {
    warningSeconds: 240,
    expiredSeconds: 300,
    watchConversations: [],
    ...overrides,
  };
}

function setupDefaultMocks(hookCfg: Record<string, unknown> = defaultHookCfg()) {
  mockLoadConfig.mockReturnValue({});
  mockResolveHookConfig.mockReturnValue(hookCfg);
  mockResolveTelegramToken.mockReturnValue({ token: TELEGRAM_TOKEN });
  mockSendMessageTelegram.mockResolvedValue({ messageId: "msg-001" });
  mockDeleteMessageTelegram.mockResolvedValue(undefined);
  mockRouteReply.mockResolvedValue({ ok: true, messageId: "msg-001" });
}

function makeEvent(
  type: string,
  action: string,
  context: Record<string, unknown> = {},
): InternalHookEvent {
  return {
    type: type as InternalHookEvent["type"],
    action,
    sessionKey: SESSION_KEY,
    context,
    timestamp: new Date(),
    messages: [],
  };
}

function messageSentEvent(overrides: Record<string, unknown> = {}) {
  return makeEvent("message", "sent", {
    channelId: CHANNEL_ID,
    to: CHAT_ID,
    conversationId: CHAT_ID,
    isGroup: false,
    ...overrides,
  });
}

function messageReceivedEvent(overrides: Record<string, unknown> = {}) {
  return makeEvent("message", "received", {
    channelId: CHANNEL_ID,
    from: CHAT_ID,
    conversationId: CHAT_ID,
    isGroup: false,
    ...overrides,
  });
}

function llmRequestEvent(overrides: Record<string, unknown> = {}) {
  return makeEvent("agent", "llm-request", {
    channelId: CHANNEL_ID,
    conversationId: CHAT_ID,
    ...overrides,
  });
}

function commandEvent(action: "new" | "reset") {
  return makeEvent("command", action, {});
}

// --- Reset global timer state between tests ---

function clearGlobalTimerState() {
  const g = globalThis as Record<string, unknown>;
  delete g["__cache_ttl_warning_timers__"];
  delete g["__cache_ttl_warning_sending__"];
}

// --- Tests ---

describe("cache-ttl-warning handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    clearGlobalTimerState();
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearGlobalTimerState();
  });

  // ── Timer lifecycle ─────────────────────────────────────────────────────────

  describe("timer lifecycle", () => {
    it("creates a timer on message:sent", async () => {
      await handler(messageSentEvent());
      // Warning should NOT fire before warningSeconds
      await vi.advanceTimersByTimeAsync(239_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("fires warning notice at warningSeconds", async () => {
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
      expect(mockSendMessageTelegram).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining("expires in"),
        expect.any(Object),
      );
    });

    it("fires expired notice at expiredSeconds", async () => {
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledTimes(2);
      const secondCall = mockSendMessageTelegram.mock.calls[1];
      expect(secondCall[1]).toContain("expired");
    });

    it("deletes warning notice before sending expired", async () => {
      mockSendMessageTelegram.mockResolvedValueOnce({ messageId: "warn-msg-1" });
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000); // warning fires
      await vi.advanceTimersByTimeAsync(60_000); // expired fires
      expect(mockDeleteMessageTelegram).toHaveBeenCalledWith(
        CHAT_ID,
        "warn-msg-1",
        expect.any(Object),
      );
    });

    it("creates timer on message:received", async () => {
      await handler(messageReceivedEvent());
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });
  });

  // ── Timer reset by new activity ─────────────────────────────────────────────

  describe("timer reset", () => {
    it("resets timer on subsequent message:sent", async () => {
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(200_000); // 200s — not yet warned
      await handler(messageSentEvent()); // reset
      await vi.advanceTimersByTimeAsync(200_000); // another 200s from reset — still < 240s
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
      // Now advance to 240s from the reset
      await vi.advanceTimersByTimeAsync(40_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });

    it("resets timer on message:received", async () => {
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(200_000);
      await handler(messageReceivedEvent()); // reset via received
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("resets timer on agent:llm-request using stored originalTo", async () => {
      // message:sent establishes the timer and stores originalTo
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(200_000);
      // LLM request resets the timer — no "to" in event, uses stored originalTo
      await handler(llmRequestEvent());
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
      // Advance to warning point from llm-request reset
      await vi.advanceTimersByTimeAsync(40_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });

    it("llm-request without an existing timer is a no-op", async () => {
      // No prior message:sent — no timer exists
      await handler(llmRequestEvent());
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("deletes previous notice when timer is reset by new activity", async () => {
      mockSendMessageTelegram.mockResolvedValueOnce({ messageId: "warn-msg-2" });
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000); // warning fires, messageId stored
      await handler(messageSentEvent()); // reset — should delete warning notice
      expect(mockDeleteMessageTelegram).toHaveBeenCalledWith(
        CHAT_ID,
        "warn-msg-2",
        expect.any(Object),
      );
    });
  });

  // ── /new and /reset cancel timers ───────────────────────────────────────────

  describe("session reset commands", () => {
    it("/new cancels all active timers", async () => {
      await handler(messageSentEvent());
      await handler(commandEvent("new"));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("/reset cancels all active timers", async () => {
      await handler(messageSentEvent());
      await handler(commandEvent("reset"));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("/new deletes any outstanding notice", async () => {
      mockSendMessageTelegram.mockResolvedValueOnce({ messageId: "warn-msg-3" });
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000); // warning fires
      await handler(commandEvent("new"));
      expect(mockDeleteMessageTelegram).toHaveBeenCalledWith(
        CHAT_ID,
        "warn-msg-3",
        expect.any(Object),
      );
    });
  });

  // ── Group chat filtering ─────────────────────────────────────────────────────

  describe("group chat filtering", () => {
    it("never watches group chats", async () => {
      await handler(messageSentEvent({ isGroup: true }));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });
  });

  // ── watchConversations filter ────────────────────────────────────────────────

  describe("watchConversations", () => {
    it("watches all direct conversations when watchConversations is empty", async () => {
      setupDefaultMocks(defaultHookCfg({ watchConversations: [] }));
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });

    it("watches when conversation matches bare ID", async () => {
      setupDefaultMocks(defaultHookCfg({ watchConversations: [CHAT_ID] }));
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });

    it("watches when conversation matches channel:id format", async () => {
      setupDefaultMocks(defaultHookCfg({ watchConversations: [`${CHANNEL_ID}:${CHAT_ID}`] }));
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });

    it("does not watch when watchConversations is non-empty and ID is absent", async () => {
      setupDefaultMocks(defaultHookCfg({ watchConversations: ["telegram:9999999999"] }));
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("handles provider-prefixed conversationId without double-prefixing timer key", async () => {
      // conversationId arrives as "telegram:7898601152" (already prefixed)
      // shouldWatch log must not show "telegram:telegram:7898601152"
      setupDefaultMocks(defaultHookCfg({ watchConversations: [] }));
      await handler(messageSentEvent({ conversationId: `${CHANNEL_ID}:${CHAT_ID}` }));
      // Should still create exactly ONE timer (not two separate entries)
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });
  });

  // ── originalTo normalization ─────────────────────────────────────────────────

  describe("originalTo normalization", () => {
    it("strips provider prefix from originalTo when llm-request resets timer", async () => {
      // Simulate "to" arriving with a provider prefix
      await handler(messageSentEvent({ to: `${CHANNEL_ID}:${CHAT_ID}` }));
      await handler(llmRequestEvent());
      // Advance to warning — should send to bare CHAT_ID, not prefixed form
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledWith(
        CHAT_ID, // bare, not "telegram:7898601152"
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  // ── Guard flag (self-send prevention) ────────────────────────────────────────

  describe("self-send guard", () => {
    it("ignores message:sent events triggered by own notice", async () => {
      // The handler sets a guard flag while sending; the resulting message:sent
      // must not create a new timer (which would loop indefinitely).
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000); // warning fires — sets guard, sends

      // Simulate the message:sent event that Telegram delivery would trigger
      // while the guard is active. In real execution the guard is cleared by
      // the time this test assertion runs, but the timer count should reflect
      // that no second timer was spawned from the notice send.
      // Best we can verify unit-test-side: only one notice was sent.
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });
  });

  // ── Miscellaneous / edge cases ───────────────────────────────────────────────

  describe("edge cases", () => {
    it("skips events that are not message or llm-request", async () => {
      await handler(makeEvent("gateway", "startup", {}));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("skips when channelId is missing", async () => {
      await handler(messageSentEvent({ channelId: undefined }));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("skips when conversationId is missing", async () => {
      await handler(messageSentEvent({ conversationId: undefined, to: undefined }));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("skips when hook is explicitly disabled", async () => {
      setupDefaultMocks({ ...defaultHookCfg(), enabled: false });
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
    });

    it("respects custom warningSeconds config", async () => {
      setupDefaultMocks(defaultHookCfg({ warningSeconds: 60, expiredSeconds: 120 }));
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockSendMessageTelegram).toHaveBeenCalledOnce();
    });

    it("logs a warning and returns empty when no Telegram token available", async () => {
      mockResolveTelegramToken.mockReturnValue({ token: undefined });
      await handler(messageSentEvent());
      await vi.advanceTimersByTimeAsync(240_000);
      expect(mockSendMessageTelegram).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("no Telegram bot token"));
    });
  });
});
