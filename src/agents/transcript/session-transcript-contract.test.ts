import { describe, expect, test } from "vitest";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
} from "./session-transcript-contract.js";

describe("session transcript contract", () => {
  test("parses JSONL transcript entries tolerantly", () => {
    const entries = parseSessionEntries(
      [
        JSON.stringify({
          type: "session",
          id: "session-1",
          timestamp: "2026-05-06T00:00:00.000Z",
          cwd: "/tmp/work",
        }),
        "{not-json",
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-05-06T00:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        }),
      ].join("\n"),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe("session");
    expect(entries[1]?.type).toBe("message");
  });

  test("migrates legacy transcript entries to the current OpenClaw schema", () => {
    const entries = parseSessionEntries(
      [
        JSON.stringify({
          type: "session",
          id: "session-1",
          timestamp: "2026-05-06T00:00:00.000Z",
          cwd: "/tmp/work",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-06T00:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-06T00:00:02.000Z",
          message: { role: "hookMessage", content: "legacy", timestamp: 2 },
        }),
        JSON.stringify({
          type: "compaction",
          timestamp: "2026-05-06T00:00:03.000Z",
          summary: "summary",
          firstKeptEntryIndex: 1,
          tokensBefore: 100,
        }),
      ].join("\n"),
    );

    migrateSessionEntries(entries);

    const header = entries[0] as SessionHeader;
    const [first, second, compaction] = entries.slice(1) as SessionEntry[];
    expect(header.version).toBe(CURRENT_SESSION_VERSION);
    expect(first.id).toEqual(expect.any(String));
    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.id);
    expect(second.type).toBe("message");
    if (second.type !== "message") {
      throw new Error("expected migrated message entry");
    }
    expect(second.message.role).toBe("custom");
    expect(compaction.parentId).toBe(second.id);
    expect(compaction.type).toBe("compaction");
    if (compaction.type !== "compaction") {
      throw new Error("expected migrated compaction entry");
    }
    expect(compaction.firstKeptEntryId).toBe(first.id);
    expect(compaction).not.toHaveProperty("firstKeptEntryIndex");
  });

  test("builds context from the active transcript branch", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-05-06T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "assistant-1",
        timestamp: "2026-05-06T00:00:03.000Z",
        thinkingLevel: "high",
      },
      {
        type: "model_change",
        id: "model-1",
        parentId: "thinking-1",
        timestamp: "2026-05-06T00:00:04.000Z",
        provider: "openai",
        modelId: "gpt-5.5",
      },
      {
        type: "branch_summary",
        id: "summary-1",
        parentId: "model-1",
        timestamp: "2026-05-06T00:00:05.000Z",
        fromId: "assistant-1",
        summary: "Explored an alternate path.",
      },
      {
        type: "custom_message",
        id: "custom-1",
        parentId: "summary-1",
        timestamp: "2026-05-06T00:00:06.000Z",
        customType: "openclaw:test",
        content: "Injected context",
        display: false,
      },
    ];

    const context = buildSessionContext(entries);

    expect(context.thinkingLevel).toBe("high");
    expect(context.model).toEqual({ provider: "openai", modelId: "gpt-5.5" });
    expect(context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "branchSummary",
      "custom",
    ]);
    expect(context.messages[2]).toMatchObject({
      role: "branchSummary",
      summary: "Explored an alternate path.",
      fromId: "assistant-1",
      timestamp: Date.parse("2026-05-06T00:00:05.000Z"),
    });
    expect(context.messages[3]).toMatchObject({
      role: "custom",
      customType: "openclaw:test",
      content: "Injected context",
      display: false,
      timestamp: Date.parse("2026-05-06T00:00:06.000Z"),
    });
  });

  test("builds compacted context with kept messages and tail", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "old-user",
        parentId: null,
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
      {
        type: "message",
        id: "kept-user",
        parentId: "old-user",
        timestamp: "2026-05-06T00:00:02.000Z",
        message: { role: "user", content: "kept", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "kept-user",
        timestamp: "2026-05-06T00:00:03.000Z",
        summary: "Older history summary.",
        firstKeptEntryId: "kept-user",
        tokensBefore: 123,
      },
      {
        type: "message",
        id: "tail-user",
        parentId: "compact-1",
        timestamp: "2026-05-06T00:00:04.000Z",
        message: { role: "user", content: "tail", timestamp: 4 },
      },
    ];

    const context = buildSessionContext(entries);

    expect(context.messages).toMatchObject([
      {
        role: "compactionSummary",
        summary: "Older history summary.",
        tokensBefore: 123,
        timestamp: Date.parse("2026-05-06T00:00:03.000Z"),
      },
      { role: "user", content: "kept" },
      { role: "user", content: "tail" },
    ]);
  });
});
