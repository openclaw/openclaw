import { describe, expect, test } from "vitest";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";

// Inline the helper functions for testing (same logic as in chat.ts)
function isHeartbeatOnlyMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "assistant") {
    return false;
  }

  if (typeof entry.content === "string") {
    const trimmed = entry.content.trim();
    return trimmed === HEARTBEAT_TOKEN || trimmed.startsWith(`${HEARTBEAT_TOKEN}\n`);
  }

  if (Array.isArray(entry.content)) {
    const textParts = entry.content
      .filter(
        (item) => item && typeof item === "object" && (item as { type?: string }).type === "text",
      )
      .map((item) => ((item as { text?: string }).text ?? "").trim())
      .filter((t) => t.length > 0);
    if (textParts.length === 0) {
      return false;
    }
    const combined = textParts.join(" ").trim();
    return combined === HEARTBEAT_TOKEN || combined.startsWith(`${HEARTBEAT_TOKEN} `);
  }

  return false;
}

function filterHeartbeatMessages(messages: unknown[], showOk: boolean): unknown[] {
  if (showOk) {
    return messages;
  }
  return messages.filter((msg) => !isHeartbeatOnlyMessage(msg));
}

describe("chat.history heartbeat filtering", () => {
  test("isHeartbeatOnlyMessage returns true for assistant HEARTBEAT_OK string content", () => {
    const msg = { role: "assistant", content: "HEARTBEAT_OK" };
    expect(isHeartbeatOnlyMessage(msg)).toBe(true);
  });

  test("isHeartbeatOnlyMessage returns true for assistant HEARTBEAT_OK with whitespace", () => {
    const msg = { role: "assistant", content: "  HEARTBEAT_OK  " };
    expect(isHeartbeatOnlyMessage(msg)).toBe(true);
  });

  test("isHeartbeatOnlyMessage returns true for assistant HEARTBEAT_OK with trailing newline content", () => {
    const msg = { role: "assistant", content: "HEARTBEAT_OK\n" };
    expect(isHeartbeatOnlyMessage(msg)).toBe(true);
  });

  test("isHeartbeatOnlyMessage returns false for assistant with additional content", () => {
    const msg = { role: "assistant", content: "HEARTBEAT_OK but also this message" };
    expect(isHeartbeatOnlyMessage(msg)).toBe(false);
  });

  test("isHeartbeatOnlyMessage returns false for user messages", () => {
    const msg = { role: "user", content: "HEARTBEAT_OK" };
    expect(isHeartbeatOnlyMessage(msg)).toBe(false);
  });

  test("isHeartbeatOnlyMessage returns true for array content with single HEARTBEAT_OK text block", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "HEARTBEAT_OK" }],
    };
    expect(isHeartbeatOnlyMessage(msg)).toBe(true);
  });

  test("isHeartbeatOnlyMessage returns false for array content with real message", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "Here's a helpful response." }],
    };
    expect(isHeartbeatOnlyMessage(msg)).toBe(false);
  });

  test("isHeartbeatOnlyMessage returns false for empty content", () => {
    const msg = { role: "assistant", content: [] };
    expect(isHeartbeatOnlyMessage(msg)).toBe(false);
  });

  test("filterHeartbeatMessages removes HEARTBEAT_OK when showOk is false", () => {
    const messages = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello! How can I help?" },
    ];
    const filtered = filterHeartbeatMessages(messages, false);
    expect(filtered).toHaveLength(3);
    expect(filtered.map((m) => (m as { role: string }).role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
  });

  test("filterHeartbeatMessages keeps all messages when showOk is true", () => {
    const messages = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello! How can I help?" },
    ];
    const filtered = filterHeartbeatMessages(messages, true);
    expect(filtered).toHaveLength(4);
  });

  test("filterHeartbeatMessages handles multiple HEARTBEAT_OK messages", () => {
    const messages = [
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "assistant", content: "Actual content here" },
    ];
    const filtered = filterHeartbeatMessages(messages, false);
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as { content: string }).content).toBe("Actual content here");
  });
});
