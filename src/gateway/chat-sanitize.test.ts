import { describe, expect, test } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { filterHeartbeatOkMessages, stripEnvelopeFromMessage } from "./chat-sanitize.js";

describe("stripEnvelopeFromMessage", () => {
  test("removes message_id hint lines from user messages", () => {
    const input = {
      role: "user",
      content: "[WhatsApp 2026-01-24 13:36] yolo\n[message_id: 7b8b]",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("yolo");
  });

  test("removes message_id hint lines from text content arrays", () => {
    const input = {
      role: "user",
      content: [{ type: "text", text: "hi\n[message_id: abc123]" }],
    };
    const result = stripEnvelopeFromMessage(input) as {
      content?: Array<{ type: string; text?: string }>;
    };
    expect(result.content?.[0]?.text).toBe("hi");
  });

  test("does not strip inline message_id text that is part of a line", () => {
    const input = {
      role: "user",
      content: "I typed [message_id: 123] on purpose",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("I typed [message_id: 123] on purpose");
  });

  test("does not strip assistant messages", () => {
    const input = {
      role: "assistant",
      content: "note\n[message_id: 123]",
    };
    const result = stripEnvelopeFromMessage(input) as { content?: string };
    expect(result.content).toBe("note\n[message_id: 123]");
  });
});

describe("filterHeartbeatOkMessages", () => {
  test("removes heartbeat prompt + HEARTBEAT_OK response pair", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "what's up?" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(3);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "what's up?" },
    ]);
  });

  test("removes standalone HEARTBEAT_OK response without preceding prompt", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(1);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  test("keeps heartbeat runs that produced actual content (alerts)", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "⚠️ Disk usage is at 95%!" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(2);
  });

  test("handles HEARTBEAT_OK with markup wrapping", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "**HEARTBEAT_OK**" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(0);
  });

  test("handles HEARTBEAT_OK with underscore wrapping", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "_HEARTBEAT_OK_" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(0);
  });

  test("handles content array format", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: HEARTBEAT_PROMPT }] },
      { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(0);
  });

  test("returns same array reference when no filtering needed", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toBe(messages);
  });

  test("returns empty array for empty input", () => {
    const result = filterHeartbeatOkMessages([]);
    expect(result).toEqual([]);
  });

  test("removes multiple heartbeat pairs", () => {
    const messages = [
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "real message" },
      { role: "assistant", content: "real response" },
      { role: "user", content: HEARTBEAT_PROMPT },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ];
    const result = filterHeartbeatOkMessages(messages);
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { role: "user", content: "real message" },
      { role: "assistant", content: "real response" },
    ]);
  });
});
