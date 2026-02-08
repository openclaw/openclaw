import { describe, expect, test } from "vitest";
import { filterHeartbeatMessages, isHeartbeatOkMessage } from "./chat-history-heartbeat.js";

// ---------------------------------------------------------------------------
// isHeartbeatOkMessage
// ---------------------------------------------------------------------------

describe("isHeartbeatOkMessage", () => {
  test("detects plain HEARTBEAT_OK assistant message (content array)", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      }),
    ).toBe(true);
  });

  test("detects plain HEARTBEAT_OK assistant message (string content)", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(true);
  });

  test("detects HEARTBEAT_OK with surrounding whitespace", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: "  HEARTBEAT_OK  ",
      }),
    ).toBe(true);
  });

  test("detects HEARTBEAT_OK wrapped in markdown bold", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: "**HEARTBEAT_OK**",
      }),
    ).toBe(true);
  });

  test("detects HEARTBEAT_OK wrapped in HTML bold", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: "<b>HEARTBEAT_OK</b>",
      }),
    ).toBe(true);
  });

  test("rejects user messages", () => {
    expect(
      isHeartbeatOkMessage({
        role: "user",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });

  test("rejects system messages", () => {
    expect(
      isHeartbeatOkMessage({
        role: "system",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });

  test("rejects assistant messages with real content", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: "Nothing to report. HEARTBEAT_OK",
      }),
    ).toBe(false);
  });

  test("rejects empty assistant messages", () => {
    expect(
      isHeartbeatOkMessage({
        role: "assistant",
        content: "",
      }),
    ).toBe(false);
  });

  test("rejects null/undefined", () => {
    expect(isHeartbeatOkMessage(null)).toBe(false);
    expect(isHeartbeatOkMessage(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterHeartbeatMessages
// ---------------------------------------------------------------------------

describe("filterHeartbeatMessages", () => {
  const heartbeatPrompt = {
    role: "user",
    content:
      "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
  };

  const heartbeatReply = {
    role: "assistant",
    content: [{ type: "text", text: "HEARTBEAT_OK" }],
  };

  const normalUser = {
    role: "user",
    content: "Hello, how are you?",
  };

  const normalAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "I'm doing great!" }],
  };

  test("removes heartbeat prompt+reply pair", () => {
    const messages = [normalUser, normalAssistant, heartbeatPrompt, heartbeatReply];
    const filtered = filterHeartbeatMessages(messages);
    expect(filtered).toEqual([normalUser, normalAssistant]);
  });

  test("removes only heartbeat reply when prompt does not contain HEARTBEAT_OK", () => {
    const customPrompt = {
      role: "user",
      content: "Check if everything is okay",
    };
    const messages = [normalUser, normalAssistant, customPrompt, heartbeatReply];
    const filtered = filterHeartbeatMessages(messages);
    // Custom prompt is kept because it doesn't contain HEARTBEAT_OK
    expect(filtered).toEqual([normalUser, normalAssistant, customPrompt]);
  });

  test("handles multiple heartbeat exchanges interspersed with real messages", () => {
    const messages = [
      heartbeatPrompt,
      heartbeatReply,
      normalUser,
      normalAssistant,
      heartbeatPrompt,
      heartbeatReply,
    ];
    const filtered = filterHeartbeatMessages(messages);
    expect(filtered).toEqual([normalUser, normalAssistant]);
  });

  test("returns same reference when no heartbeats found", () => {
    const messages = [normalUser, normalAssistant];
    const filtered = filterHeartbeatMessages(messages);
    expect(filtered).toBe(messages); // same reference = no copy
  });

  test("handles empty array", () => {
    expect(filterHeartbeatMessages([])).toEqual([]);
  });

  test("handles heartbeat reply at index 0 (no preceding prompt)", () => {
    const messages = [heartbeatReply, normalUser, normalAssistant];
    const filtered = filterHeartbeatMessages(messages);
    expect(filtered).toEqual([normalUser, normalAssistant]);
  });

  test("does not remove alert messages that contain real content", () => {
    const alertReply = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "You have 3 unread emails. HEARTBEAT_OK",
        },
      ],
    };
    const messages = [heartbeatPrompt, alertReply];
    const filtered = filterHeartbeatMessages(messages);
    // Alert reply is kept because it has real content beyond HEARTBEAT_OK
    expect(filtered).toEqual([heartbeatPrompt, alertReply]);
  });

  test("handles consecutive heartbeat replies without prompts", () => {
    const messages = [heartbeatReply, heartbeatReply, normalUser];
    const filtered = filterHeartbeatMessages(messages);
    expect(filtered).toEqual([normalUser]);
  });
});
