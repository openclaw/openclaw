// QA channel protocol tests cover synthetic channel payload validation and parsing.
import { describe, expect, it } from "vitest";
import { buildQaTarget, parseQaTarget, sanitizeQaBusToolCalls } from "./qa-channel-protocol.js";

describe("qa-channel protocol", () => {
  it("builds canonical targets", () => {
    expect(buildQaTarget({ chatType: "direct", conversationId: "Alice" })).toBe("dm:Alice");
    expect(buildQaTarget({ chatType: "group", conversationId: "Room" })).toBe("group:Room");
    expect(buildQaTarget({ chatType: "channel", conversationId: "Room" })).toBe("channel:Room");
    expect(buildQaTarget({ chatType: "channel", conversationId: "Room", threadId: "Topic" })).toBe(
      "thread:Room/Topic",
    );
    expect(buildQaTarget({ chatType: "direct", conversationId: "Alice", threadId: "Topic" })).toBe(
      "thread:/v1/dm/Alice/Topic",
    );
    expect(
      buildQaTarget({ chatType: "group", conversationId: "Room/One", threadId: "Topic/Two" }),
    ).toBe("thread:/v1/group/Room%2FOne/Topic%2FTwo");
  });

  it("parses canonical targets without folding ids or prefix casing", () => {
    expect(parseQaTarget("channel:CaseSensitive")).toEqual({
      chatType: "channel",
      conversationId: "CaseSensitive",
    });
    expect(parseQaTarget("thread:Room/Topic")).toEqual({
      chatType: "channel",
      conversationId: "Room",
      threadId: "Topic",
    });
    expect(parseQaTarget("thread:/v1/group/Room%2FOne/Topic%2FTwo")).toEqual({
      chatType: "group",
      conversationId: "Room/One",
      threadId: "Topic/Two",
    });
    expect(parseQaTarget("thread:/v1/dm/Alice/Topic")).toEqual({
      chatType: "direct",
      conversationId: "Alice",
      threadId: "Topic",
    });
    expect(parseQaTarget("bare-id", { defaultChatType: "group" })).toEqual({
      chatType: "group",
      conversationId: "bare-id",
    });
    expect(() => parseQaTarget("CHANNEL:CaseSensitive")).toThrow(
      "qa-channel target prefixes must be lowercase",
    );
    expect(() => parseQaTarget("thread:Room/")).toThrow("invalid qa-channel thread target");
    expect(() => parseQaTarget("thread:/v1/group/Room/%GG")).toThrow(
      "invalid qa-channel thread target",
    );
  });

  it("sanitizes QA bus tool-call arguments before persistence", () => {
    const toolCalls = sanitizeQaBusToolCalls([
      null,
      { name: 123 },
      {
        name: " exec ",
        arguments: {
          command: "cat README.md",
          apiToken: "secret-token",
          headers: {
            Authorization: "Bearer sk_test_12345678901234567890",
          },
          headerPairs: [
            ["X-API-Key", "secret"],
            ["Accept", "application/json"],
          ],
          argv: ["gh", "api", "--token", "secret-token", "repos/openclaw/openclaw"],
          values: ["ok", { password: "hunter2" }],
        },
      },
    ]);

    expect(toolCalls).toEqual([
      {
        name: "exec",
        arguments: {
          command: "[redacted]",
          apiToken: "[redacted]",
          headers: {
            Authorization: "[redacted]",
          },
          headerPairs: [
            ["[redacted]", "[redacted]"],
            ["[redacted]", "[redacted]"],
          ],
          argv: ["[redacted]", "[redacted]", "[redacted]", "[redacted]", "[redacted]"],
          values: ["[redacted]", { password: "[redacted]" }],
        },
      },
    ]);
  });

  it("caps QA bus tool-call sanitization before processing the tail", () => {
    const toolCalls = Array.from({ length: 50 }, (_, index) => ({
      name: `tool-${index}`,
    }));
    toolCalls.push({
      get name(): string {
        throw new Error("tail should not be sanitized");
      },
    });

    expect(sanitizeQaBusToolCalls(toolCalls)?.map((toolCall) => toolCall.name)).toHaveLength(50);
  });
});
