import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readLatestRecentSessionUsageFromTranscriptAsync,
  readLatestSessionUsageFromTranscript,
  readLatestSessionUsageFromTranscriptAsync,
  readRecentSessionMessages,
  readRecentSessionMessagesWithStats,
  readRecentSessionMessagesWithStatsAsync,
  readRecentSessionTranscriptEvents,
  readRecentSessionUsageFromTranscript,
  readRecentSessionUsageFromTranscriptAsync,
  readSessionMessageCount,
  readSessionMessageCountAsync,
  readSessionMessages,
  readSessionMessagesAsync,
  readSessionPreviewItemsFromTranscript,
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync,
} from "./session-transcript-readers.js";

type TranscriptEvent = Record<string, unknown>;

let previousStateDir: string | undefined;
let stateDir = "";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
});

function setupState(prefix = "openclaw-session-utils-sqlite-") {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENCLAW_STATE_DIR = stateDir;
}

function seedTranscript(params: {
  sessionId: string;
  agentId?: string;
  events: TranscriptEvent[];
}) {
  if (!stateDir) {
    setupState();
  }
  const agentId = params.agentId ?? "main";
  replaceSqliteSessionTranscriptEvents({
    agentId,
    sessionId: params.sessionId,
    events: params.events,
    now: () => 1_778_100_000_000,
  });
  return { agentId, sessionId: params.sessionId };
}

function buildBasicSessionTranscript(
  sessionId: string,
  userText = "Hello world",
  assistantText = "Hi there",
): unknown[] {
  return [
    { type: "session", version: 1, id: sessionId },
    { message: { role: "user", content: userText } },
    { message: { role: "assistant", content: assistantText } },
  ];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMessageFields(
  message: unknown,
  fields: { role?: string; content?: unknown; openclaw?: Record<string, unknown> },
) {
  const record = requireRecord(message, "message");
  if ("role" in fields) {
    expect(record.role).toBe(fields.role);
  }
  if ("content" in fields) {
    expect(record.content).toEqual(fields.content);
  }
  if (fields.openclaw) {
    const metadata = requireRecord(record.__openclaw, "message metadata");
    for (const [key, value] of Object.entries(fields.openclaw)) {
      expect(metadata[key]).toEqual(value);
    }
  }
}

function header(sessionId: string): TranscriptEvent {
  return { type: "session", version: 1, id: sessionId };
}

function message(
  role: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): TranscriptEvent {
  return { message: { role, content, ...extra } };
}

describe("SQLite transcript readers", () => {
  test("extracts first and last message previews from SQLite transcripts", async () => {
    setupState();
    const sessionId = "preview-session";
    const scope = { agentId: "main", sessionId };
    seedTranscript({
      sessionId,
      events: [
        header(sessionId),
        message("system", "System prompt"),
        message("user", [{ type: "input_text", text: "First user question" }]),
        message("assistant", [{ type: "output_text", text: "Final assistant reply" }]),
      ],
    });

    expect(readFirstUserMessageFromTranscript(scope)).toBe("First user question");
    expect(readLastMessagePreviewFromTranscript(scope)).toBe("Final assistant reply");
    await expect(readSessionTitleFieldsFromTranscriptAsync(scope)).resolves.toEqual(
      readSessionTitleFieldsFromTranscript(scope),
    );
  });

  test("skips inter-session user messages by default", () => {
    setupState();
    const sessionId = "inter-session";
    const scope = { agentId: "main", sessionId };
    seedTranscript({
      sessionId,
      events: [
        message("user", "Forwarded", {
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        }),
        message("user", "Real user message"),
      ],
    });

    expect(readFirstUserMessageFromTranscript(scope)).toBe("Real user message");
  });

  test("reads active branches, compaction markers, counts, and bounded recent messages", async () => {
    setupState();
    const sessionId = "branch-session";
    const scope = { agentId: "main", sessionId };
    seedTranscript({
      sessionId,
      events: [
        header(sessionId),
        { type: "message", id: "root", parentId: null, message: { role: "user", content: "root" } },
        {
          type: "message",
          id: "old",
          parentId: "root",
          message: { role: "assistant", content: "old branch" },
        },
        {
          type: "message",
          id: "active",
          parentId: "root",
          message: { role: "assistant", content: "active branch" },
        },
        {
          type: "compaction",
          id: "compact",
          parentId: "active",
          timestamp: new Date().toISOString(),
          summary: "summary",
          firstKeptEntryId: "root",
          tokensBefore: 123,
        },
        {
          type: "message",
          id: "tail",
          parentId: "compact",
          message: { role: "user", content: "tail" },
        },
      ],
    });

    expect(
      readSessionMessages(scope).map((entry) => (entry as { content?: unknown }).content),
    ).toEqual(["root", "active branch", [{ type: "text", text: "Compaction" }], "tail"]);
    expect(readSessionMessageCount(scope)).toBe(4);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(4);
    expect(
      readRecentSessionMessages(scope, { maxMessages: 2 }).map(
        (entry) => (entry as { content?: unknown }).content,
      ),
    ).toEqual([[{ type: "text", text: "Compaction" }], "tail"]);
    await expect(
      readSessionMessagesAsync(scope, {
        mode: "recent",
        maxMessages: 1,
      }),
    ).resolves.toEqual([expect.objectContaining({ content: "tail" })]);
  });

  test("adds sequence metadata to recent message windows", async () => {
    setupState();
    const sessionId = "stats-session";
    const scope = { agentId: "main", sessionId };
    seedTranscript({
      sessionId,
      events: [
        header(sessionId),
        message("user", "one"),
        message("assistant", "two"),
        message("user", "three"),
        message("assistant", "four"),
      ],
    });

    expect(readRecentSessionMessagesWithStats(scope, { maxMessages: 2 })).toMatchObject({
      totalMessages: 4,
      messages: [
        { __openclaw: { seq: 3 }, content: "three" },
        { __openclaw: { seq: 4 }, content: "four" },
      ],
    });
    await expect(
      readRecentSessionMessagesWithStatsAsync(scope, {
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
      totalMessages: 4,
      messages: [{ __openclaw: { seq: 4 }, content: "four" }],
    });
  });

  test("reads transcript event windows from SQLite for manual compaction", () => {
    setupState();
    const sessionId = "manual-window";
    seedTranscript({
      sessionId,
      events: [
        header(sessionId),
        ...Array.from({ length: 10 }, (_, i) => message("user", `m${i}`)),
      ],
    });

    const result = readRecentSessionTranscriptEvents({
      agentId: "main",
      sessionId,
      maxEvents: 3,
    });
    expect(result?.totalEvents).toBe(11);
    expect(
      result?.events.map((event) => (event as { message?: { content?: string } }).message?.content),
    ).toEqual(["m7", "m8", "m9"]);
  });

  test("aggregates and reads latest usage snapshots from SQLite", async () => {
    setupState();
    const sessionId = "usage-session";
    const scope = { agentId: "main", sessionId };
    seedTranscript({
      sessionId,
      events: [
        header(sessionId),
        message("assistant", "a", {
          provider: "openai",
          model: "gpt-5.4",
          usage: { input: 10, output: 2, cacheRead: 3, cost: { total: 0.1 } },
        }),
        message("assistant", "b", {
          provider: "openai",
          model: "gpt-5.4",
          usage: { input: 20, output: 4, cacheRead: 5, cost: { total: 0.2 } },
        }),
      ],
    });

    expect(readLatestSessionUsageFromTranscript(scope)).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.4",
      inputTokens: 30,
      outputTokens: 6,
      cacheRead: 8,
      costUsd: 0.30000000000000004,
    });
    await expect(readLatestSessionUsageFromTranscriptAsync(scope)).resolves.toMatchObject({
      inputTokens: 30,
      outputTokens: 6,
    });
    await expect(
      readLatestRecentSessionUsageFromTranscriptAsync(scope, 1024),
    ).resolves.toMatchObject({ inputTokens: 20, outputTokens: 4 });
    await expect(readRecentSessionUsageFromTranscriptAsync(scope, 1024)).resolves.toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
    });
    expect(readRecentSessionUsageFromTranscript(scope, 1024)).toMatchObject({
      inputTokens: 30,
      outputTokens: 6,
    });
  });

  test("builds preview items from SQLite transcripts", () => {
    setupState();
    const sessionId = "preview-items";
    const scope = { agentId: "main", sessionId };
    seedTranscript({
      sessionId,
      events: createToolSummaryPreviewTranscriptLines(sessionId).map(
        (line) => JSON.parse(line) as TranscriptEvent,
      ),
    });

    const result = readSessionPreviewItemsFromTranscript(scope, 3, 120);
    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call weather");
  });

  test("requires explicit SQLite transcript scope", () => {
    setupState();
    const sessionId = "cross-agent";
    seedTranscript({
      agentId: "ops",
      sessionId,
      events: [header(sessionId), message("user", "from ops")],
    });

    expect(readSessionMessages({ sessionId })).toEqual([]);
    expect(readSessionMessages({ agentId: "ops", sessionId })).toEqual([
      expect.objectContaining({ content: "from ops" }),
    ]);
  });
});
