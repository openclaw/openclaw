import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  DEFAULT_REPLAY_MAX_MESSAGES,
  replayRecentUserAssistantMessages,
} from "./session-transcript-replay.js";

describe("replayRecentUserAssistantMessages", () => {
  let root = "";
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-"));
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  function seedTranscript(params: {
    agentId?: string;
    sessionId: string;
    transcriptPath?: string;
    events: unknown[];
  }): string {
    const agentId = params.agentId ?? "main";
    const transcriptPath =
      params.transcriptPath ??
      path.join(root, "agents", agentId, "sessions", `${params.sessionId}.jsonl`);
    replaceSqliteSessionTranscriptEvents({
      agentId,
      sessionId: params.sessionId,
      transcriptPath,
      events: params.events,
      now: () => 1_770_000_000_000,
    });
    return transcriptPath;
  }

  function readEvents(agentId = "main", sessionId = "new-session"): unknown[] {
    return loadSqliteSessionTranscriptEvents({ agentId, sessionId }).map((entry) => entry.event);
  }

  const call = (sourceTranscript: string, targetTranscript: string): Promise<number> =>
    replayRecentUserAssistantMessages({
      sourceTranscript,
      targetTranscript,
      newSessionId: "new-session",
    });

  it("replays only the user/assistant tail and skips tool/system records", async () => {
    const source = seedTranscript({
      sessionId: "prev",
      events: [
        { type: "session", id: "old" },
        ...Array.from({ length: DEFAULT_REPLAY_MAX_MESSAGES + 4 }, (_, i) => ({
          message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` },
        })),
        { message: { role: "tool" } },
        { type: "compaction", timestamp: new Date().toISOString() },
      ],
    });
    const target = path.join(root, "agents", "main", "sessions", "next.jsonl");

    expect(await call(source, target)).toBe(DEFAULT_REPLAY_MAX_MESSAGES);
    const records = readEvents();
    expect(records[0]).toMatchObject({ type: "session", id: "new-session" });
    expect(records).toHaveLength(1 + DEFAULT_REPLAY_MAX_MESSAGES);
    for (const r of records.slice(1) as Array<{ message: { role: string } }>) {
      expect(["user", "assistant"]).toContain(r.message.role);
    }
    expect(await call(path.join(root, "missing.jsonl"), target)).toBe(0);

    const assistantSource = seedTranscript({
      sessionId: "all-assistant",
      events: Array.from({ length: 3 }, () => ({
        message: { role: "assistant", content: "x" },
      })),
    });
    expect(
      await call(assistantSource, path.join(root, "agents", "main", "sessions", "out.jsonl")),
    ).toBe(0);
    expect(readEvents("main", "new-session")).toHaveLength(1 + DEFAULT_REPLAY_MAX_MESSAGES);
  });

  it("keeps a pre-existing target header and aligns the tail to a user turn", async () => {
    const target = seedTranscript({
      sessionId: "new-session",
      events: [{ type: "session", id: "existing" }],
    });
    const source = seedTranscript({
      sessionId: "prev",
      events: Array.from({ length: DEFAULT_REPLAY_MAX_MESSAGES + 1 }, (_, i) => ({
        message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` },
      })),
    });

    expect(await call(source, target)).toBe(DEFAULT_REPLAY_MAX_MESSAGES - 1);
    const records = readEvents();
    expect(records.filter((r) => (r as { type?: unknown }).type === "session")).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "existing" });
    expect((records[1] as { message: { role: string } }).message.role).toBe("user");
  });

  it("coalesces same-role runs so replayed records strictly alternate", async () => {
    const source = seedTranscript({
      sessionId: "prev",
      events: [
        { message: { role: "user", content: "older user" } },
        { message: { role: "user", content: "latest user" } },
        { message: { role: "assistant", content: "older assistant" } },
        { message: { role: "assistant", content: "latest assistant" } },
        { message: { role: "user", content: "follow-up" } },
        { message: { role: "assistant", content: "answer" } },
      ],
    });
    const target = path.join(root, "agents", "main", "sessions", "next.jsonl");

    expect(await call(source, target)).toBe(4);
    const records = readEvents().slice(1) as Array<{ message: { role: string; content: string } }>;
    expect(records.map((r) => r.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(records.map((r) => r.message.content)).toEqual([
      "latest user",
      "latest assistant",
      "follow-up",
      "answer",
    ]);
  });

  it("replays from explicit scoped SQLite transcript events", async () => {
    seedTranscript({
      agentId: "target",
      sessionId: "old-session",
      events: [
        { type: "session", id: "old-session" },
        { message: { role: "user", content: "sqlite user" } },
        { message: { role: "tool", content: "skip me" } },
        { message: { role: "assistant", content: "sqlite assistant" } },
      ],
    });
    const target = path.join(root, "agents", "target", "sessions", "next.jsonl");

    expect(
      await replayRecentUserAssistantMessages({
        sourceAgentId: "target",
        sourceSessionId: "old-session",
        sourceTranscript: path.join(root, "missing.jsonl"),
        targetAgentId: "target",
        targetTranscript: target,
        newSessionId: "new-session",
      }),
    ).toBe(2);

    const records = readEvents("target");
    expect(records[0]).toMatchObject({ type: "session", id: "new-session" });
    expect(
      (records.slice(1) as Array<{ message: { content: string } }>).map((r) => r.message.content),
    ).toEqual(["sqlite user", "sqlite assistant"]);
  });
});
