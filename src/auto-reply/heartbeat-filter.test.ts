import { describe, expect, it } from "vitest";
import {
  filterHeartbeatPairs,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";

describe("isHeartbeatUserMessage", () => {
  it("returns true for default heartbeat prompt (string content)", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
      }),
    ).toBe(true);
  });

  it("returns true for task-based heartbeat prompt", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content:
          "Run the following periodic tasks:\n- email-check: Check for urgent unread emails\nAfter completing all due tasks, reply HEARTBEAT_OK.",
      }),
    ).toBe(true);
  });

  it("returns true for content block array containing HEARTBEAT_OK", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: [
          { type: "text", text: "Check workspace and reply HEARTBEAT_OK if nothing to do." },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for normal user message", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "What is the weather today?",
      }),
    ).toBe(false);
  });

  it("returns false for assistant messages", () => {
    expect(
      isHeartbeatUserMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });
});

describe("isHeartbeatOkResponse", () => {
  it("returns true for plain HEARTBEAT_OK", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(true);
  });

  it("returns true for HEARTBEAT_OK with markup", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "**HEARTBEAT_OK**",
      }),
    ).toBe(true);
  });

  it("returns true for HEARTBEAT_OK in content blocks", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      }),
    ).toBe(true);
  });

  it("returns false for response with real content", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "You have 3 unread urgent emails. HEARTBEAT_OK",
      }),
    ).toBe(false);
  });

  it("returns false for user messages", () => {
    expect(
      isHeartbeatOkResponse({
        role: "user",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "",
      }),
    ).toBe(false);
  });
});

describe("filterHeartbeatPairs", () => {
  it("removes heartbeat user+HEARTBEAT_OK assistant pairs", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "Read HEARTBEAT.md if it exists. reply HEARTBEAT_OK." },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ];

    const filtered = filterHeartbeatPairs(messages);
    expect(filtered).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ]);
  });

  it("preserves heartbeat turns that produced real content", () => {
    const messages = [
      { role: "user", content: "Read HEARTBEAT.md. reply HEARTBEAT_OK if nothing to do." },
      { role: "assistant", content: "You have 3 urgent emails to review." },
    ];

    const filtered = filterHeartbeatPairs(messages);
    expect(filtered).toEqual(messages);
  });

  it("removes multiple consecutive heartbeat pairs", () => {
    const messages = [
      { role: "user", content: "reply HEARTBEAT_OK if nothing." },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "reply HEARTBEAT_OK if nothing." },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];

    const filtered = filterHeartbeatPairs(messages);
    expect(filtered).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ]);
  });

  it("returns original array if no heartbeat pairs found", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const filtered = filterHeartbeatPairs(messages);
    expect(filtered).toEqual(messages);
  });

  it("handles empty message array", () => {
    expect(filterHeartbeatPairs([])).toEqual([]);
  });

  it("handles single message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    expect(filterHeartbeatPairs(messages)).toEqual(messages);
  });

  it("does not filter heartbeat user message without matching assistant response", () => {
    const messages = [
      { role: "user", content: "reply HEARTBEAT_OK." },
      { role: "user", content: "Actually, check my calendar." },
      { role: "assistant", content: "You have a meeting at 3pm." },
    ];

    const filtered = filterHeartbeatPairs(messages);
    expect(filtered).toEqual(messages);
  });
});
