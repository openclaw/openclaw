import type {
  SessionHeader,
  SessionMessageEntry,
  CompactionEntry,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { sessionEntriesToMarkdown } from "./session-export.js";

function makeHeader(overrides?: Partial<SessionHeader>): SessionHeader {
  return {
    type: "session",
    version: 3,
    id: "test-session-123",
    timestamp: "2026-03-20T10:30:00.000Z",
    cwd: "/tmp/test",
    ...overrides,
  };
}

function makeUserEntry(text: string, ts = 1742470200000): SessionMessageEntry {
  return {
    type: "message",
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "user" as const,
      content: text,
      timestamp: ts,
    },
  };
}

function makeAssistantEntry(
  text: string,
  ts = 1742470260000,
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>,
): SessionMessageEntry {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  > = [];

  if (text) {
    content.push({ type: "text" as const, text });
  }

  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({
        type: "toolCall" as const,
        id: `tc-${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
  }

  return {
    type: "message",
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant" as const,
      content,
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: ts,
    },
  };
}

function makeToolResultEntry(
  toolName: string,
  text: string,
  ts = 1742470280000,
  isError = false,
): SessionMessageEntry {
  return {
    type: "message",
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult" as const,
      toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
      toolName,
      content: [{ type: "text" as const, text }],
      isError,
      timestamp: ts,
    },
  };
}

describe("sessionEntriesToMarkdown", () => {
  it("renders header with session id and start time", () => {
    const md = sessionEntriesToMarkdown(makeHeader(), []);
    expect(md).toContain("# Session: test-session-123");
    expect(md).toContain("**Started:**");
    expect(md).toContain("**Messages:** 0");
  });

  it("renders a simple user-assistant exchange", () => {
    const entries = [
      makeUserEntry("Hello, what is the weather?"),
      makeAssistantEntry("I can help with that. Let me check."),
    ];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    expect(md).toContain("**User**");
    expect(md).toContain("Hello, what is the weather?");
    expect(md).toContain("**Assistant**");
    expect(md).toContain("I can help with that. Let me check.");
    expect(md).toContain("**Messages:** 2");
  });

  it("collapses tool calls into details blocks with tool name", () => {
    const entries = [
      makeAssistantEntry("Checking...", 1742470260000, [
        { name: "weather.get", arguments: { city: "SF" } },
      ]),
    ];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>Tool call: weather.get</summary>");
    expect(md).toContain("weather.get");
    expect(md).toContain("</details>");
  });

  it("collapses tool results into details blocks", () => {
    const entries = [makeToolResultEntry("weather.get", "72F, sunny")];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    expect(md).toContain("<details>");
    expect(md).toContain("Tool result: weather.get");
    expect(md).toContain("72F, sunny");
  });

  it("marks error tool results", () => {
    const entries = [makeToolResultEntry("api.call", "Connection timeout", 1742470280000, true)];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    expect(md).toContain("(error)");
  });

  it("truncates long tool results with ellipsis", () => {
    const longText = "x".repeat(1000);
    const entries = [makeToolResultEntry("read", longText)];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    expect(md).toContain("...");
    expect(md).not.toContain("x".repeat(501));
  });

  it("handles compaction entries", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "comp-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "Compacted earlier messages",
      firstKeptEntryId: "msg-1",
      tokensBefore: 50000,
    };
    const md = sessionEntriesToMarkdown(makeHeader(), [
      compaction as unknown as SessionMessageEntry,
    ]);
    expect(md).toContain("*[Session compacted]*");
  });

  it("handles empty session", () => {
    const md = sessionEntriesToMarkdown(makeHeader(), []);
    expect(md).toContain("# Session: test-session-123");
    expect(md).toContain("**Messages:** 0");
  });

  it("handles null header", () => {
    const md = sessionEntriesToMarkdown(null, [makeUserEntry("test")]);
    expect(md).toContain("# Session: unknown");
  });

  it("handles legacy assistant messages with string content", () => {
    const entry: SessionMessageEntry = {
      type: "message",
      id: "msg-legacy",
      parentId: null,
      timestamp: new Date(1742470260000).toISOString(),
      message: {
        role: "assistant" as const,
        content: "This is a legacy string response" as never,
        api: "anthropic-messages" as const,
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: 1742470260000,
      },
    };
    const md = sessionEntriesToMarkdown(makeHeader(), [entry]);
    expect(md).toContain("**Assistant**");
    expect(md).toContain("This is a legacy string response");
  });

  it("escapes triple backticks in tool result output", () => {
    const entries = [makeToolResultEntry("bash", "output:\n```\nsome code\n```\nend")];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    // The inner backticks from the tool output should be escaped
    expect(md).toContain("\\`\\`\\`");
    expect(md).not.toContain("output:\n```\n");
  });

  it("truncates long tool results to 500 characters", () => {
    const longText = "x".repeat(1000);
    const entries = [makeToolResultEntry("read", longText)];
    const md = sessionEntriesToMarkdown(makeHeader(), entries);
    expect(md).toContain("...");
    const codeBlockMatch = md.match(/```\n([\s\S]*?)\n```/);
    expect(codeBlockMatch).toBeTruthy();
    // 500 chars + "..." = 503
    expect(codeBlockMatch![1]!.length).toBeLessThanOrEqual(503);
  });

  it("handles user message with image content", () => {
    const entry: SessionMessageEntry = {
      type: "message",
      id: "msg-img",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "What is this?" },
          { type: "image" as const, data: "base64data", mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    };
    const md = sessionEntriesToMarkdown(makeHeader(), [entry]);
    expect(md).toContain("What is this?");
    expect(md).toContain("[Image]");
  });
});
