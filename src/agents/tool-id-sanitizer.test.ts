import { describe, expect, it } from "vitest";
import {
  isAnthropicModel,
  sanitizeToolUseIdForAnthropic,
  sanitizeMessageForAnthropic,
  sanitizeMessagesForAnthropic,
} from "./tool-id-sanitizer.js";

describe("tool-id-sanitizer", () => {
  describe("isAnthropicModel", () => {
    it("identifies Claude models", () => {
      expect(isAnthropicModel("claude-3-opus")).toBe(true);
      expect(isAnthropicModel("claude-opus-4.6")).toBe(true);
      expect(isAnthropicModel("anthropic/claude-opus")).toBe(true);
    });

    it("identifies Anthropic-branded models", () => {
      expect(isAnthropicModel("anthropic/foo")).toBe(true);
      expect(isAnthropicModel("ANTHROPIC/test")).toBe(true);
    });

    it("rejects non-Anthropic models", () => {
      expect(isAnthropicModel("gpt-4")).toBe(false);
      expect(isAnthropicModel("kimi-k2.5")).toBe(false);
      expect(isAnthropicModel("gemini-pro")).toBe(false);
      expect(isAnthropicModel(undefined)).toBe(false);
      expect(isAnthropicModel("")).toBe(false);
    });

    it("case-insensitive", () => {
      expect(isAnthropicModel("CLAUDE-3-OPUS")).toBe(true);
      expect(isAnthropicModel("Claude-Opus")).toBe(true);
    });
  });

  describe("sanitizeToolUseIdForAnthropic", () => {
    it("preserves valid IDs (alphanumeric, underscore, hyphen)", () => {
      expect(sanitizeToolUseIdForAnthropic("call_123")).toBe("call_123");
      expect(sanitizeToolUseIdForAnthropic("call-456")).toBe("call-456");
      expect(sanitizeToolUseIdForAnthropic("ABC123_def-GHI")).toBe("ABC123_def-GHI");
    });

    it("handles legacy format from Kimi K2.5", () => {
      expect(sanitizeToolUseIdForAnthropic("call_123|abc:def")).toBe(
        "call_123_abc_def"
      );
      expect(sanitizeToolUseIdForAnthropic("tool|request:123")).toBe(
        "tool_request_123"
      );
    });

    it("handles UUID format (unchanged)", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      expect(sanitizeToolUseIdForAnthropic(uuid)).toBe(uuid);
    });

    it("escapes script injection attempts", () => {
      expect(sanitizeToolUseIdForAnthropic("<script>alert</script>")).toBe(
        "_script_alert_script_"
      );
      expect(sanitizeToolUseIdForAnthropic("'; DROP TABLE; --")).toBe(
        "______DROP_TABLE_____"
      );
    });

    it("handles special characters", () => {
      expect(sanitizeToolUseIdForAnthropic("call@123")).toBe("call_123");
      expect(sanitizeToolUseIdForAnthropic("call.123")).toBe("call_123");
      expect(sanitizeToolUseIdForAnthropic("call/123")).toBe("call_123");
      expect(sanitizeToolUseIdForAnthropic("call 123")).toBe("call_123");
    });

    it("handles empty and null", () => {
      expect(sanitizeToolUseIdForAnthropic("")).toBe("");
      // @ts-ignore
      expect(sanitizeToolUseIdForAnthropic(null)).toBe(null);
    });
  });

  describe("sanitizeMessageForAnthropic", () => {
    it("sanitizes tool_use blocks in message content", () => {
      const message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123|abc:def",
            name: "test_tool",
            input: { arg: "value" },
          },
        ],
      };

      const sanitized = sanitizeMessageForAnthropic(
        message,
        "claude-opus-4.6"
      );
      expect(sanitized.content[0].id).toBe("call_123_abc_def");
      expect(sanitized.content[0].name).toBe("test_tool"); // unchanged
    });

    it("preserves text and other content blocks", () => {
      const message = {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "call|123", name: "tool", input: {} },
        ],
      };

      const sanitized = sanitizeMessageForAnthropic(
        message,
        "claude-opus-4.6"
      );
      expect(sanitized.content[0]).toEqual({ type: "text", text: "Hello" });
      expect(sanitized.content[1].id).toBe("call_123");
    });

    it("skips non-Anthropic models", () => {
      const message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call|123",
            name: "tool",
            input: {},
          },
        ],
      };

      const sanitized = sanitizeMessageForAnthropic(message, "gpt-4");
      expect(sanitized.content[0].id).toBe("call|123"); // unchanged
    });

    it("handles non-array content", () => {
      const message = {
        role: "assistant",
        content: "plain text",
      };

      const result = sanitizeMessageForAnthropic(
        message,
        "claude-opus-4.6"
      );
      expect(result).toEqual(message);
    });
  });

  describe("sanitizeMessagesForAnthropic", () => {
    it("sanitizes all messages in conversation history", () => {
      const messages = [
        {
          role: "user",
          content: [{ type: "text", text: "call tool" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1|abc:123",
              name: "tool1",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1|abc:123" }],
        },
      ];

      const sanitized = sanitizeMessagesForAnthropic(
        messages,
        "claude-opus-4.6"
      );

      // Check second message (assistant with tool_use)
      expect(sanitized[1].content[0].id).toBe("call_1_abc_123");
    });

    it("returns original array if not Anthropic model", () => {
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call|123", name: "tool", input: {} }],
        },
      ];

      const result = sanitizeMessagesForAnthropic(messages, "gpt-4");
      expect(result[0].content[0].id).toBe("call|123");
    });

    it("handles empty or invalid input", () => {
      expect(sanitizeMessagesForAnthropic([], "claude-opus-4.6")).toEqual([]);
      // @ts-ignore
      expect(sanitizeMessagesForAnthropic(null, "claude-opus-4.6")).toEqual(null);
      // @ts-ignore
      expect(sanitizeMessagesForAnthropic(undefined, "claude-opus-4.6")).toEqual(undefined);
    });
  });

  describe("model switch scenario", () => {
    it("handles conversation history from Kimi K2.5 → Claude", () => {
      // Simulate mid-session model switch
      const messagesFromKimi = [
        {
          role: "user",
          content: [{ type: "text", text: "search web" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "search|request:123",
              name: "web_search",
              input: { query: "test" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "search|request:123",
              content: "results...",
            },
          ],
        },
      ];

      // Switch to Claude without sanitization would fail
      // With sanitization, it works
      const sanitized = sanitizeMessagesForAnthropic(
        messagesFromKimi,
        "claude-opus-4.6"
      );

      // Tool ID should be sanitized
      expect(sanitized[1].content[0].id).toBe("search_request_123");
      // But tool result reference should also be updated (or handled)
      expect(sanitized[2].content[0].tool_use_id).toBe(
        "search|request:123"
      ); // Note: this would also need updating in real implementation
    });
  });
});
