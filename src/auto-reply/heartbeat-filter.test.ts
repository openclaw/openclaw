import { describe, expect, it } from "vitest";
import {
  filterHeartbeatPairs,
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "./heartbeat-filter.js";

describe("isHeartbeatUserMessage", () => {
  it("matches heartbeat prompts", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.",
      }),
    ).toBe(true);

    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "return HEARTBEAT_OK if nothing is needed",
      }),
    ).toBe(true);
  });

  it("ignores quoted or non-user token mentions", () => {
    expect(
      isHeartbeatUserMessage({
        role: "user",
        content: "What does HEARTBEAT_OK mean? I keep seeing it in logs.",
      }),
    ).toBe(false);

    expect(
      isHeartbeatUserMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ).toBe(false);
  });
});

describe("isHeartbeatOkResponse", () => {
  it("matches no-op heartbeat acknowledgements", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "**HEARTBEAT_OK**",
      }),
    ).toBe(true);

    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "You have 3 unread urgent emails. HEARTBEAT_OK",
      }),
    ).toBe(true);
  });

  it("preserves meaningful or non-text responses", () => {
    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: "Status HEARTBEAT_OK due to watchdog failure",
      }),
    ).toBe(false);

    expect(
      isHeartbeatOkResponse({
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }],
      }),
    ).toBe(false);
  });

  it("respects ackMaxChars overrides", () => {
    expect(
      isHeartbeatOkResponse(
        {
          role: "assistant",
          content: "HEARTBEAT_OK all good",
        },
        0,
      ),
    ).toBe(false);
  });
});

describe("filterHeartbeatPairs", () => {
  it("removes no-op heartbeat pairs", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "reply HEARTBEAT_OK if nothing." },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ];

    expect(filterHeartbeatPairs(messages)).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What time is it?" },
      { role: "assistant", content: "It is 3pm." },
    ]);
  });

  it("keeps meaningful heartbeat results and non-text assistant turns", () => {
    const meaningfulMessages = [
      { role: "user", content: "reply HEARTBEAT_OK if nothing." },
      { role: "assistant", content: "Status HEARTBEAT_OK due to watchdog failure" },
    ];
    expect(filterHeartbeatPairs(meaningfulMessages)).toEqual(meaningfulMessages);

    const nonTextMessages = [
      { role: "user", content: "reply HEARTBEAT_OK if nothing." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }],
      },
    ];
    expect(filterHeartbeatPairs(nonTextMessages)).toEqual(nonTextMessages);
  });
});
