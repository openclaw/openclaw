import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalHookEvent, type AgentToAgentHookContext } from "../../internal-hooks.js";

// Mock external dependencies before imports
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    hooks: {
      internal: {
        entries: {
          "a2a-logging": {
            enabled: true,
            chatId: "-1001234567890",
            topicId: 12345,
          },
        },
      },
    },
    channels: {
      telegram: {
        botToken: "fake-bot-token",
      },
    },
  })),
}));

vi.mock("../../../telegram/token.js", () => ({
  resolveTelegramToken: vi.fn(() => ({ token: "fake-bot-token", source: "config" })),
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("a2a-logging handler", () => {
  describe("formatA2ALogMessage", () => {
    it("should format message with agent IDs and UTC timestamp", async () => {
      const { formatA2ALogMessage } = await import("./handler.js");
      const timestamp = new Date("2026-03-04T14:32:00Z");
      const result = formatA2ALogMessage("finance", "dev", "Review transactions", timestamp);

      expect(result).toContain("<code>[14:32]</code>");
      expect(result).toContain("<b>finance</b>");
      expect(result).toContain("<b>dev</b>");
      expect(result).toContain("->");
      expect(result).toContain("Review transactions");
    });

    it("should truncate long messages to 200 chars", async () => {
      const { formatA2ALogMessage } = await import("./handler.js");
      const longMessage = "x".repeat(300);
      const result = formatA2ALogMessage("a", "b", longMessage, new Date());

      expect(result).toContain("x".repeat(200) + "...");
      expect(result).not.toContain("x".repeat(300));
    });

    it("should escape HTML in agent IDs and messages", async () => {
      const { formatA2ALogMessage } = await import("./handler.js");
      const result = formatA2ALogMessage("test<script>", "b&c", "<b>bold</b> & stuff", new Date());

      expect(result).toContain("test&lt;script&gt;");
      expect(result).toContain("b&amp;c");
      expect(result).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; stuff");
    });
  });

  describe("postToTelegram", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn(() =>
        Promise.resolve({
          ok: true,
          text: () => Promise.resolve("{}"),
        }),
      );
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should POST to Telegram API with correct params", async () => {
      const { postToTelegram } = await import("./handler.js");
      await postToTelegram("my-token", "-100123", 456, "Hello");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.telegram.org/botmy-token/sendMessage");
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body.chat_id).toBe("-100123");
      expect(body.message_thread_id).toBe(456);
      expect(body.text).toBe("Hello");
      expect(body.parse_mode).toBe("HTML");
      expect(body.disable_notification).toBe(true);
    });

    it("should omit message_thread_id when topicId is undefined", async () => {
      const { postToTelegram } = await import("./handler.js");
      await postToTelegram("my-token", "-100123", undefined, "Hello");

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body.message_thread_id).toBeUndefined();
    });

    it("should throw on non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      });

      const { postToTelegram } = await import("./handler.js");
      await expect(postToTelegram("t", "c", 1, "x")).rejects.toThrow("Telegram API 403: Forbidden");
    });
  });

  describe("handler integration", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn(() =>
        Promise.resolve({
          ok: true,
          text: () => Promise.resolve("{}"),
        }),
      );
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should post to Telegram for agent_to_agent:send events", async () => {
      const { default: handler } = await import("./handler.js");
      const context: AgentToAgentHookContext = {
        sourceSessionKey: "agent:finance:main",
        sourceAgentId: "finance",
        targetSessionKey: "agent:dev:main",
        targetAgentId: "dev",
        message: "Please review",
      };
      const event = createInternalHookEvent(
        "agent_to_agent",
        "send",
        "agent:finance:main",
        context,
      );
      await handler(event);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain("sendMessage");
    });

    it("should skip non-agent_to_agent events", async () => {
      const { default: handler } = await import("./handler.js");
      const event = createInternalHookEvent("message", "sent", "test", {
        to: "someone",
        content: "hello",
        success: true,
        channelId: "telegram",
      });
      await handler(event);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should not throw on Telegram API errors", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      const { default: handler } = await import("./handler.js");
      const context: AgentToAgentHookContext = {
        sourceSessionKey: "agent:a:main",
        sourceAgentId: "a",
        targetSessionKey: "agent:b:main",
        targetAgentId: "b",
        message: "test",
      };
      const event = createInternalHookEvent("agent_to_agent", "send", "agent:a:main", context);
      await expect(handler(event)).resolves.toBeUndefined();
    });
  });
});
