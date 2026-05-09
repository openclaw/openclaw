import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { createSqliteSessionTranscriptLocator } from "./test-helpers/transcript-locator.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  readTailAssistantTextFromSessionTranscript,
} from "./transcript.js";
import type { SessionEntry } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("appendAssistantMessageToSessionTranscript", () => {
  useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";
  type ExactAssistantMessage = Parameters<
    typeof appendExactAssistantMessageToSessionTranscript
  >[0]["message"];

  async function writeTranscriptStore(
    store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
        updatedAt: 1,
      },
    },
  ) {
    for (const [key, entry] of Object.entries(store)) {
      upsertSessionEntry({ agentId: "main", sessionKey: key, entry });
    }
  }

  function readEvents(targetSessionId = sessionId) {
    return loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: targetSessionId,
    }).map(
      (entry) =>
        entry.event as {
          type?: string;
          id?: string;
          parentId?: string | null;
          message?: {
            role?: string;
            provider?: string;
            model?: string;
            content?: Array<{ type?: string; text?: string }> | string;
            idempotencyKey?: string;
          };
        },
    );
  }

  function createExactAssistantMessage(params: {
    text?: string;
    content?: ExactAssistantMessage["content"];
    provider?: string;
    model?: string;
  }): ExactAssistantMessage {
    return {
      role: "assistant",
      content: params.content ?? [{ type: "text", text: params.text ?? "" }],
      api: "openai-responses",
      provider: params.provider ?? "codex",
      model: params.model ?? "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  it("appends SQLite transcript message for valid session", async () => {
    await writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const events = readEvents();
      expect(events.length).toBe(2);

      const header = events[0];
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = events[1];
      expect(messageLine.type).toBe("message");
      expect(messageLine.message?.role).toBe("assistant");
      const content = messageLine.message?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(Array.isArray(content) ? content[0]?.type : undefined).toBe("text");
      expect(Array.isArray(content) ? content[0]?.text : undefined).toBe(
        "Hello from delivery mirror!",
      );
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
    });

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        agentId: "main",
        sessionId: "test-session-id",
        messageId: expect.any(String),
        message: expect.objectContaining({
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "Hello from delivery mirror!" }],
        }),
      }),
    );
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    await writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
    });

    const events = readEvents();
    expect(events.length).toBe(2);
    const messageLine = events[1];
    expect(messageLine?.message?.idempotencyKey).toBe("mirror:test-source-message");
    const content = messageLine?.message?.content;
    expect(Array.isArray(content) ? content[0]?.text : undefined).toBe(
      "Hello from delivery mirror!",
    );
  });

  it("uses scoped SQLite transcript events for delivery mirror idempotency", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await writeTranscriptStore();
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId,
      event: {
        type: "message",
        id: "sqlite-mirror-message",
        message: {
          role: "assistant",
          idempotencyKey: "mirror:sqlite-source-message",
          content: [{ type: "text", text: "Hello from SQLite mirror!" }],
        },
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Hello from SQLite mirror!",
      idempotencyKey: "mirror:sqlite-source-message",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "sqlite-mirror-message",
    });
    expect(readEvents()).toHaveLength(1);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not append a duplicate delivery mirror when the latest assistant message already matches", async () => {
    await writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({ text: "Hello from Codex!" }),
    });

    expect(exactResult.ok).toBe(true);

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from Codex!",
    });

    expect(mirrorResult.ok).toBe(true);
    if (exactResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      const events = readEvents();
      expect(events.length).toBe(2);

      const messageLine = events[1];
      expect(messageLine?.message?.provider).toBe("codex");
      expect(messageLine?.message?.model).toBe("gpt-5.4");
      const content = messageLine?.message?.content;
      expect(Array.isArray(content) ? content[0]?.text : undefined).toBe("Hello from Codex!");
    }
  });

  it("uses scoped SQLite transcript events for delivery mirror latest-match dedupe", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await writeTranscriptStore();
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId,
      event: {
        type: "message",
        id: "sqlite-latest-assistant",
        message: createExactAssistantMessage({ text: "Already delivered" }),
      },
    });

    const result = await appendAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      text: "Already delivered",
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: "sqlite-latest-assistant",
    });
    expect(readEvents()).toHaveLength(1);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    await writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const events = readEvents();
      expect(events.length).toBe(4);

      const messageLine = events[3];
      expect(messageLine?.message?.provider).toBe("openclaw");
      expect(messageLine?.message?.model).toBe("delivery-mirror");
      const content = messageLine?.message?.content;
      expect(Array.isArray(content) ? content[0]?.text : undefined).toBe("Repeated answer");
    }
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:imessage:direct:+15551234567";
    const store: Record<string, SessionEntry> = {
      [storeKey]: {
        sessionId: "test-session-normalized",
        chatType: "direct",
        channel: "imessage",
        updatedAt: 1,
      },
    };
    await writeTranscriptStore(store);

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:iMessage:direct:+15551234567",
      text: "Hello normalized!",
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store: Record<string, SessionEntry> = {
      [storeKey]: {
        sessionId: "test-slack-session",
        chatType: "direct",
        channel: "slack",
        updatedAt: 1,
      },
    };
    await writeTranscriptStore(store);

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    await writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
    });

    expect(result.ok).toBe(true);
    expect(readEvents()).toHaveLength(2);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    await writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      message: createExactAssistantMessage({
        content: [
          {
            type: "text",
            text: "internal reasoning",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          },
        ],
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const messageLine = readEvents()[1];
      expect(messageLine?.message?.content).toEqual([
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ]);
    }
  });

  it("can emit signal-only transcript refresh events for exact assistant appends", async () => {
    await writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      updateMode: "signal-only",
      message: createExactAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey,
          agentId: "main",
          sessionId: "test-session-id",
        }),
      );
    }
    emitSpy.mockRestore();
  });

  it("serializes concurrent parent-linked transcript appends", async () => {
    const targetSessionId = "concurrent-tree-session";
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: { type: "session", id: targetSessionId },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: {
        type: "message",
        id: "root-message",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "root" },
      },
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendSessionTranscriptMessage({
          agentId: "main",
          sessionId: targetSessionId,
          message: { role: "assistant", content: `reply ${index}` },
        }),
      ),
    );

    const records = readEvents(targetSessionId).filter((record) => record.type === "message");

    expect(records).toHaveLength(9);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]?.parentId).toBe(records[index - 1]?.id);
    }
  });

  it("appends to existing SQLite transcript chains", async () => {
    const targetSessionId = "small-linear-session";
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: { type: "session", version: 3, id: targetSessionId },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: {
        type: "message",
        id: "legacy-first",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "legacy first" },
      },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: targetSessionId,
      event: {
        type: "message",
        id: "legacy-second",
        parentId: "legacy-first",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "legacy second" },
      },
    });

    const appended = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: targetSessionId,
      message: { role: "assistant", content: "new reply" },
    });

    const records = readEvents(targetSessionId);
    const messages = records.filter((record) => record.type === "message");

    expect(messages.map((record) => record.message?.content)).toEqual([
      "legacy first",
      "legacy second",
      "new reply",
    ]);
    expect(messages[0]).toMatchObject({ id: "legacy-first", parentId: null });
    expect(messages[1]).toMatchObject({ id: "legacy-second", parentId: "legacy-first" });
    expect(messages[2]).toMatchObject({
      id: appended.messageId,
      parentId: "legacy-second",
    });
  });

  it("appends scoped SQLite transcript entries without importing JSONL at runtime", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-import-session",
      event: { type: "session", version: 3, id: "sqlite-import-session" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-import-session",
      event: {
        type: "message",
        id: "legacy-first",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "legacy first" },
      },
      now: () => 101,
    });

    const appended = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: "sqlite-import-session",
      message: { role: "assistant", content: "new reply" },
      now: 123,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "sqlite-import-session",
    }).map((entry) => entry.event as { type?: string; id?: string; parentId?: string | null });

    expect(events.map((event) => event.type)).toEqual(["session", "message", "message"]);
    expect(events[1]).toMatchObject({ id: "legacy-first", parentId: null });
    expect(events[2]).toMatchObject({ id: appended.messageId, parentId: "legacy-first" });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("mirrors a newly created scoped transcript header into SQLite", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const appended = await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId: "sqlite-new-session",
      cwd: "/workspace",
      message: { role: "assistant", content: "new reply" },
      now: 456,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "sqlite-new-session",
    }).map((entry) => entry.event as { type?: string; id?: string; message?: unknown });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "session",
      id: "sqlite-new-session",
      cwd: "/workspace",
    });
    expect(events[1]).toMatchObject({
      type: "message",
      id: appended.messageId,
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("appends scoped SQLite transcript entries without registering fake file paths", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionId = "sqlite-locator-session";

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      cwd: "/workspace",
      message: { role: "assistant", content: "locator reply" },
      now: 789,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId,
    }).map((entry) => entry.event as { type?: string; message?: unknown });
    expect(events.map((event) => event.type)).toEqual(["session", "message"]);

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("reads latest and tail assistant text from scoped SQLite transcripts", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-read-session",
      event: { type: "session", id: "sqlite-read-session" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-read-session",
      event: {
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          timestamp: 200,
          content: [{ type: "text", text: "first reply" }],
        },
      },
      now: () => 200,
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "main",
      sessionId: "sqlite-read-session",
      event: {
        type: "message",
        id: "assistant-2",
        message: {
          role: "assistant",
          timestamp: 300,
          content: [{ type: "text", text: "latest reply" }],
        },
      },
      now: () => 300,
    });

    await expect(
      readLatestAssistantTextFromSessionTranscript({
        agentId: "main",
        sessionId: "sqlite-read-session",
      }),
    ).resolves.toEqual({
      id: "assistant-2",
      text: "latest reply",
      timestamp: 300,
    });
    await expect(
      readTailAssistantTextFromSessionTranscript({
        agentId: "main",
        sessionId: "sqlite-read-session",
      }),
    ).resolves.toEqual({
      id: "assistant-2",
      text: "latest reply",
      timestamp: 300,
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });
});
