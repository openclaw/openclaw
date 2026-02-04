import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  buildConversationEntry,
  detectSignals,
  parseTranscript,
  shouldRecordConversation,
} from "./conversation-journal.js";

describe("parseTranscript", () => {
  it("parses user/assistant messages and ignores commands", () => {
    const raw = [
      JSON.stringify({ type: "session", timestamp: "2026-02-03T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-03T00:01:00.000Z",
        message: {
          role: "user",
          timestamp: 1700000000000,
          content: [{ type: "text", text: "Hello there" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          timestamp: 1700000001000,
          content: "Hi back",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          timestamp: 1700000002000,
          content: "/new",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "system",
          content: "ignored",
        },
      }),
    ].join("\n");

    const parsed = parseTranscript(raw);
    expect(parsed.messages.map((msg) => msg.text)).toEqual(["Hello there", "Hi back"]);
    expect(parsed.startedAt).toBe("2026-02-03T00:00:00.000Z");
    expect(parsed.lastMessageAt).toBe(new Date(1700000001000).toISOString());
  });
});

describe("detectSignals", () => {
  it("flags deploy and tests keywords", () => {
    const signals = detectSignals([
      { role: "user", text: "Deploy failed in prod", timestamp: 1 },
      { role: "assistant", text: "Run the tests and retry", timestamp: 2 },
    ]);
    expect(signals).toContain("deploy");
    expect(signals).toContain("tests");
  });
});

describe("shouldRecordConversation", () => {
  it("requires both sides to speak", () => {
    expect(
      shouldRecordConversation({
        userCount: 0,
        assistantCount: 2,
        totalChars: 500,
        signals: ["deploy"],
      }),
    ).toBe(false);
  });

  it("filters short conversations without signals", () => {
    expect(
      shouldRecordConversation({
        userCount: 2,
        assistantCount: 1,
        totalChars: 120,
        signals: [],
      }),
    ).toBe(false);
  });

  it("allows short conversations when signals exist", () => {
    expect(
      shouldRecordConversation({
        userCount: 1,
        assistantCount: 1,
        totalChars: 40,
        signals: ["deploy"],
      }),
    ).toBe(true);
  });
});

describe("buildConversationEntry", () => {
  it("returns an entry when signals are present", () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-123",
      updatedAt: Date.now(),
      channel: "telegram",
    };
    const entry = buildConversationEntry({
      sessionEntry,
      sessionKey: "agent:pulse:main",
      agentId: "pulse",
      eventAction: "new",
      commandSource: "telegram",
      messages: [
        { role: "user", text: "Deploy to prod", timestamp: 1 },
        { role: "assistant", text: "Running tests now", timestamp: 2 },
      ],
    });

    expect(entry).not.toBeNull();
    expect(entry?.session_id).toBe("session-123");
    expect(entry?.signals).toContain("deploy");
    expect(entry?.excerpt).toContain("User: Deploy to prod");
  });

  it("returns null for short conversations without signals", () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-456",
      updatedAt: Date.now(),
    };
    const entry = buildConversationEntry({
      sessionEntry,
      messages: [
        { role: "user", text: "Hi", timestamp: 1 },
        { role: "assistant", text: "Hello", timestamp: 2 },
      ],
    });

    expect(entry).toBeNull();
  });
});
