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

  it("returns false for normal conversation that quotes the token", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "What does HEARTBEAT_OK mean? I keep seeing it in logs.",
      }),
    ).toBe(false);
  });

  it("returns true for respond-style heartbeat prompt", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "Check on things and respond with HEARTBEAT_OK if all clear.",
      }),
    ).toBe(true);
  });

  it("returns true for custom prompt using 'return'", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "return HEARTBEAT_OK if nothing is needed",
      }),
    ).toBe(true);
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

  it("returns true for empty content (ok-empty no-op heartbeat)", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "",
      }),
    ).toBe(true);
  });

  it("returns true for whitespace-only content", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "   ",
      }),
    ).toBe(true);
  });

  it("returns true for HEARTBEAT_OK with responsePrefix", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "Nex HEARTBEAT_OK",
      }),
    ).toBe(true);
  });

  it("returns true for HEARTBEAT_OK with emoji suffix", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "HEARTBEAT_OK 👍",
      }),
    ).toBe(true);
  });

  it("returns true for HEARTBEAT_OK with HTML wrapper", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "<b>HEARTBEAT_OK</b>",
      }),
    ).toBe(true);
  });

  it("returns true for HEARTBEAT_OK with short alphanumeric suffix", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "HEARTBEAT_OK all good",
      }),
    ).toBe(true);
  });

  it("returns false for HEARTBEAT_OK followed by long real content", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content:
          "HEARTBEAT_OK " +
          "but I noticed you have 3 urgent emails and a calendar event in 30 minutes. " +
          "Also your Tesla is at 15% charge and the weather forecast shows heavy rain. " +
          "I recommend charging the car now and bringing an umbrella. " +
          "Additionally there are 5 open PRs that need your review and the CI pipeline " +
          "has been failing for the last 3 hours due to a flaky test in the extension shards. " +
          "I have drafted a summary of all action items for your review.",
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
