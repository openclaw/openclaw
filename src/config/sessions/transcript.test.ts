// Transcript tests cover session transcript persistence and formatting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { repairToolUseResultPairing } from "../../agents/session-transcript-repair.js";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { updateSessionStoreEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import {
  appendSessionTranscriptEvent,
  appendSessionTranscriptMessage,
} from "./transcript-append.js";
import { selectSessionTranscriptLeafControlledPath } from "./transcript-tree.js";
import {
  bindOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  readRecentUserAssistantTextForSession,
  readRecentUserAssistantTextFromSessionTranscript,
  readTailAssistantTextFromSessionTranscript,
} from "./transcript.js";

describe("appendAssistantMessageToSessionTranscript", () => {
  beforeAll(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-warm-"));
    try {
      const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({ warm: { sessionId: "warm-session", chatType: "direct" } }),
        "utf-8",
      );
      await appendAssistantMessageToSessionTranscript({
        sessionKey: "warm",
        text: "warm",
        storePath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const fixture = useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";
  type ExactAssistantMessage = Parameters<
    typeof appendExactAssistantMessageToSessionTranscript
  >[0]["message"];
  type BeforeMessageWriteParams = Parameters<
    NonNullable<
      Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]["beforeMessageWrite"]
    >
  >[0];
  type TranscriptRepairMessage = Parameters<typeof repairToolUseResultPairing>[0][number];
  type TranscriptUpdateEmitterSpy = {
    mock: {
      calls: [string | SessionTranscriptUpdate][];
    };
  };

  function writeTranscriptStore() {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          chatType: "direct",
          channel: "discord",
        },
      }),
      "utf-8",
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

  function requireTranscriptUpdateCall(spy: TranscriptUpdateEmitterSpy): SessionTranscriptUpdate {
    const call = spy.mock.calls[0];
    if (!call) {
      throw new Error("expected transcript update event");
    }
    const event = call[0];
    if (typeof event === "string") {
      throw new Error("expected structured transcript update event");
    }
    return event;
  }

  it("creates transcript file and appends message for valid session", async () => {
    writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);
      const sessionFileMode = fs.statSync(result.sessionFile).mode & 0o777;
      if (process.platform !== "win32") {
        expect(sessionFileMode).toBe(0o600);
      }

      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const header = JSON.parse(lines[0]);
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.type).toBe("message");
      expect(messageLine.message.role).toBe("assistant");
      expect(messageLine.message.content[0].type).toBe("text");
      expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
    }
  });

  it("advances the session registry marker after managed transcript appends", async () => {
    const updatedAt = Date.parse("2026-05-18T09:00:00.000Z");
    const appendedAt = Date.parse("2026-05-18T09:05:00.000Z");
    const sessionFile = "managed-marker.jsonl";
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt,
          status: "done",
        },
      }),
      "utf-8",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(appendedAt);
    try {
      const result = await appendAssistantMessageToSessionTranscript({
        sessionKey,
        text: "Hello with registry marker",
        storePath: fixture.storePath(),
      });

      expect(result.ok).toBe(true);
      const store = JSON.parse(fs.readFileSync(fixture.storePath(), "utf-8")) as Record<
        string,
        { updatedAt?: number; status?: string }
      >;
      expect(store[sessionKey]?.updatedAt).toBe(appendedAt);
      expect(store[sessionKey]?.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not advance the registry marker for duplicate delivery mirror replays", async () => {
    const updatedAt = Date.parse("2026-05-18T10:00:00.000Z");
    const firstAppendAt = Date.parse("2026-05-18T10:05:00.000Z");
    const duplicateReplayAt = Date.parse("2026-05-18T10:10:00.000Z");
    const sessionFile = "duplicate-marker.jsonl";
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt,
          status: "done",
        },
      }),
      "utf-8",
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(firstAppendAt);
      const first = await appendAssistantMessageToSessionTranscript({
        sessionKey,
        text: "Replay-safe marker",
        storePath: fixture.storePath(),
      });
      expect(first.ok).toBe(true);

      vi.setSystemTime(duplicateReplayAt);
      const duplicate = await appendAssistantMessageToSessionTranscript({
        sessionKey,
        text: "Replay-safe marker",
        storePath: fixture.storePath(),
      });
      expect(duplicate.ok).toBe(true);

      const store = JSON.parse(fs.readFileSync(fixture.storePath(), "utf-8")) as Record<
        string,
        { updatedAt?: number }
      >;
      expect(store[sessionKey]?.updatedAt).toBe(firstAppendAt);
      if (first.ok && duplicate.ok) {
        expect(duplicate.messageId).toBe(first.messageId);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses spawned cwd when creating a missing transcript header", async () => {
    const taskCwd = path.join(fixture.sessionsDir(), "task-repo");
    fs.mkdirSync(taskCwd, { recursive: true });
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          chatType: "direct",
          channel: "discord",
          spawnedCwd: taskCwd,
        },
      }),
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from task cwd!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const [headerLine] = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      const header = JSON.parse(headerLine ?? "{}") as { cwd?: string };
      expect(header.cwd).toBe(taskCwd);
    }
  });

  it("runs matching owned transcript appends through the active session write lock", async () => {
    writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const events: string[] = [];

    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey,
        withSessionWriteLock: async (run) => {
          events.push("lock");
          return await run();
        },
      },
      async () =>
        await appendAssistantMessageToSessionTranscript({
          sessionKey,
          text: "Hello under lock",
          storePath: fixture.storePath(),
        }),
    );

    expect(result.ok).toBe(true);
    expect(events).toEqual(["lock"]);
  });

  it("keeps matching owned transcript appends locked from bound callbacks", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const events: string[] = [];
    const callback = bindOwnedSessionTranscriptWrites(
      {
        sessionFile,
        sessionKey,
        withSessionWriteLock: async (run) => {
          events.push("lock");
          return await run();
        },
      },
      async () =>
        await appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          message: {
            role: "assistant",
            content: "Hello from bound delivery",
            timestamp: Date.now(),
            stopReason: "stop",
          },
        }),
    );

    const result = await callback();

    expect(result.messageId).toBeTruthy();
    expect(events).toEqual(["lock"]);
  });

  it("appends to legacy lowercase Signal group session entries", async () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const signalSessionKey = `agent:main:signal:group:${mixedGroupId}`;
    const legacySignalSessionKey = signalSessionKey.toLowerCase();
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [legacySignalSessionKey]: {
          sessionId,
          chatType: "group",
          channel: "signal",
        },
      }),
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: signalSessionKey,
      text: "Hello Signal group",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.content[0].text).toBe("Hello Signal group");
    }
  });

  it("falls back to the canonical transcript path for malformed persisted sessionFile metadata", async () => {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          sessionFile: { path: "../../escaped.jsonl" },
          updatedAt: Date.now(),
        },
      }),
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from a repaired metadata boundary",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionFile).toBe(
        resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir()),
      );
      expect(fs.existsSync(result.sessionFile)).toBe(true);
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const event = requireTranscriptUpdateCall(emitSpy);
    const message = event.message as
      | {
          role?: string;
          provider?: string;
          model?: string;
          content?: unknown;
        }
      | undefined;
    expect(event?.sessionFile).toBe(sessionFile);
    expect(event?.sessionKey).toBe(sessionKey);
    expect(event?.messageId).toBeTypeOf("string");
    expect(message?.role).toBe("assistant");
    expect(message?.provider).toBe("openclaw");
    expect(message?.model).toBe("delivery-mirror");
    expect(message?.content).toEqual([{ type: "text", text: "Hello from delivery mirror!" }]);
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const messageLine = JSON.parse(lines[1]);
    expect(messageLine.message.idempotencyKey).toBe("mirror:test-source-message");
    expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
  });

  it("does not append a duplicate delivery mirror when the latest assistant message already matches", async () => {
    writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Hello from Codex!" }),
    });

    expect(exactResult.ok).toBe(true);

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from Codex!",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (exactResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      const lines = fs.readFileSync(mirrorResult.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.provider).toBe("codex");
      expect(messageLine.message.model).toBe("gpt-5.4");
      expect(messageLine.message.content[0].text).toBe("Hello from Codex!");
    }
  });

  it("idempotently appends identified channel finals while preserving repeated replies", async () => {
    writeTranscriptStore();

    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated command reply",
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final:message-1:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-1" },
    });
    const replay = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated command reply",
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final:message-1:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-1" },
    });
    const nextTurn = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated command reply",
      storePath: fixture.storePath(),
      idempotencyKey: "channel-final:message-2:0",
      deliveryMirror: { kind: "channel-final", sourceMessageId: "message-2" },
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(nextTurn.ok).toBe(true);
    if (first.ok && replay.ok && nextTurn.ok) {
      expect(replay.messageId).toBe(first.messageId);
      expect(nextTurn.messageId).not.toBe(first.messageId);
      const lines = fs.readFileSync(first.sessionFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[1]).message.openclawDeliveryMirror).toEqual({
        kind: "channel-final",
        sourceMessageId: "message-1",
      });
    }
  });

  it("dedupes against the latest assistant even when a large user entry follows it", async () => {
    writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Hello before the large user entry" }),
    });

    expect(exactResult.ok).toBe(true);
    if (!exactResult.ok) {
      return;
    }

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "x".repeat(128 * 1024) },
    });

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript(sessionFile);
    if (!latestAssistantText) {
      throw new Error("expected latest assistant text");
    }
    expect(latestAssistantText.id).toBe(exactResult.messageId);
    expect(latestAssistantText.text).toBe("Hello before the large user entry");

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello before the large user entry",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      const records = fs
        .readFileSync(sessionFile, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } });
      expect(records.filter((record) => record.type === "message")).toHaveLength(2);
    }
  });

  it("reads bounded recent user and assistant text before the current turn", async () => {
    writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: "Analyze this chart",
        timestamp: 1_000,
        provenance: { kind: "external_user", sourceChannel: "gateway" },
      },
    });
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        ...createExactAssistantMessage({ text: "The chart is range-bound; want an alert?" }),
        timestamp: 2_000,
      },
    });
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: "no need, I closed it",
        timestamp: 3_000,
        provenance: { kind: "external_user", sourceChannel: "telegram" },
      },
    });

    const recent = await readRecentUserAssistantTextFromSessionTranscript(sessionFile, {
      beforeTimestampMs: 3_000,
      limit: 10,
    });

    expect(recent).toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "Analyze this chart",
        timestamp: 1_000,
        sourceChannel: "gateway",
      },
      {
        id: expect.any(String),
        role: "assistant",
        text: "The chart is range-bound; want an alert?",
        timestamp: 2_000,
      },
    ]);
  });

  it("skips transcript-only OpenClaw assistant entries when reading recent prompt context", async () => {
    writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "approved from gateway", timestamp: 1_000 },
    });
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        ...createExactAssistantMessage({
          text: "Transcript delivery bookkeeping",
          provider: "openclaw",
          model: "gateway-injected",
        }),
        timestamp: 2_000,
      },
    });
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        ...createExactAssistantMessage({ text: "Visible assistant reply" }),
        timestamp: 3_000,
      },
    });

    await expect(
      readRecentUserAssistantTextFromSessionTranscript(sessionFile, {
        beforeTimestampMs: 4_000,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "approved from gateway",
        timestamp: 1_000,
      },
      {
        id: expect.any(String),
        role: "assistant",
        text: "Visible assistant reply",
        timestamp: 3_000,
      },
    ]);
  });

  it("resolves recent transcript context from session identity", async () => {
    writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "from shared session", timestamp: 4_000 },
    });

    await expect(
      readRecentUserAssistantTextForSession({
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 5_000,
      }),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        role: "user",
        text: "from shared session",
        timestamp: 4_000,
      },
    ]);
  });

  it("ignores stored session files outside the sessions directory for recent context", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "outside.jsonl");
      fs.writeFileSync(
        fixture.storePath(),
        JSON.stringify({
          [sessionKey]: {
            sessionId,
            chatType: "direct",
            sessionFile: outsideFile,
          },
        }),
        "utf-8",
      );
      await appendSessionTranscriptMessage({
        transcriptPath: outsideFile,
        message: { role: "user", content: "outside text", timestamp: 1_000 },
      });
      const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: { role: "user", content: "contained text", timestamp: 2_000 },
      });

      await expect(
        readRecentUserAssistantTextForSession({
          sessionKey,
          storePath: fixture.storePath(),
          beforeTimestampMs: 3_000,
        }),
      ).resolves.toEqual([
        {
          id: expect.any(String),
          role: "user",
          text: "contained text",
          timestamp: 2_000,
        },
      ]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("skips transcript-only OpenClaw assistant entries when reading latest assistant text", async () => {
    writeTranscriptStore();

    const finalResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Complete final answer" }),
    });
    expect(finalResult.ok).toBe(true);
    if (!finalResult.ok) {
      return;
    }

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Earlier retained preview",
      storePath: fixture.storePath(),
    });
    await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        text: "Injected transcript text",
        provider: "openclaw",
        model: "gateway-injected",
      }),
    });

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript(
      finalResult.sessionFile,
    );
    expect(latestAssistantText?.id).toBe(finalResult.messageId);
    expect(latestAssistantText?.text).toBe("Complete final answer");
  });

  it("does not report transcript-only OpenClaw assistant entries as latest assistant text", async () => {
    writeTranscriptStore();

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Only delivery mirror",
      storePath: fixture.storePath(),
    });
    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }

    const latestAssistantText = await readLatestAssistantTextFromSessionTranscript(
      mirrorResult.sessionFile,
    );
    expect(latestAssistantText).toBeUndefined();
  });

  it("keeps transcript-only OpenClaw assistant entries available to the tail reader", async () => {
    writeTranscriptStore();

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Tail delivery mirror",
      storePath: fixture.storePath(),
    });
    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }

    const tailAssistantText = await readTailAssistantTextFromSessionTranscript(
      mirrorResult.sessionFile,
    );
    expect(tailAssistantText?.id).toBe(mirrorResult.messageId);
    expect(tailAssistantText?.text).toBe("Tail delivery mirror");
  });

  it("scans past trailing non-assistant entries (e.g. openclaw.cache-ttl) to find the latest assistant text", async () => {
    // Regression for openclaw/openclaw#83427: the cache-ttl custom entry was
    // emitted after the canonical assistant turn, and the tail reader returned
    // undefined on the first non-assistant line, so the gap-fill check in
    // persistTextTurnTranscript wrote a duplicate `api: "cli"` assistant
    // message — poisoning the model's own context with verbatim duplicates.
    writeTranscriptStore();

    const assistantResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({
        text: "Canonical answer",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
      }),
    });
    expect(assistantResult.ok).toBe(true);
    if (!assistantResult.ok) {
      return;
    }

    const cacheTtlEntry = `${JSON.stringify({
      type: "custom",
      customType: "openclaw.cache-ttl",
      timestamp: new Date().toISOString(),
      data: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
      },
    })}\n`;
    fs.appendFileSync(assistantResult.sessionFile, cacheTtlEntry, "utf-8");

    const tailAssistantText = await readTailAssistantTextFromSessionTranscript(
      assistantResult.sessionFile,
    );
    expect(tailAssistantText?.id).toBe(assistantResult.messageId);
    expect(tailAssistantText?.text).toBe("Canonical answer");
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
      storePath: fixture.storePath(),
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const lines = fs.readFileSync(mirrorResult.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(4);

      const messageLine = JSON.parse(lines[3]);
      expect(messageLine.message.provider).toBe("openclaw");
      expect(messageLine.message.model).toBe("delivery-mirror");
      expect(messageLine.message.content[0].text).toBe("Repeated answer");
    }
  });

  it("keeps delivery mirrors in transcripts while repair preserves real tool results", async () => {
    writeTranscriptStore();
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const toolCallId = "call_maniple_list";

    const toolCallResult = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "maniple__list_workers",
            arguments: {},
          },
        ],
        stopReason: "toolUse",
      },
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Maniple List Workers",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (!mirrorResult.ok) {
      return;
    }
    expect(mirrorResult.messageId).not.toBe(toolCallResult.messageId);
    const linesAfterMirror = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(linesAfterMirror).toHaveLength(3);
    const mirrorLine = JSON.parse(linesAfterMirror[2]);
    expect(mirrorLine.message.model).toBe("delivery-mirror");

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "maniple__list_workers",
        content: [{ type: "text", text: "workers listed" }],
        isError: false,
      },
    });

    const messages = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: TranscriptRepairMessage })
      .flatMap((entry) => (entry.message ? [entry.message] : []));
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
    ]);
    const repair = repairToolUseResultPairing(messages, {
      missingToolResultText: "aborted",
    });

    expect(repair.added).toHaveLength(0);
    expect(repair.messages.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect((repair.messages[2] as { model?: string }).model).toBe("delivery-mirror");
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:imessage:direct:+15551234567";
    const store = {
      [storeKey]: {
        sessionId: "test-session-normalized",
        chatType: "direct",
        channel: "imessage",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:iMessage:direct:+15551234567",
      text: "Hello normalized!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store = {
      [storeKey]: {
        sessionId: "test-slack-session",
        chatType: "direct",
        channel: "slack",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    writeTranscriptStore();

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        "{not-json",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            idempotencyKey: "mirror:test-source-message",
            content: [{ type: "text", text: "Hello from delivery mirror!" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
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
      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.content).toEqual([
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

  it("applies before_message_write after idempotency checks and preserves the key", async () => {
    writeTranscriptStore();
    const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => ({
      ...message,
      content: [{ type: "text" as const, text: "[redacted by hook]" }],
    }));
    const append = () =>
      appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        storePath: fixture.storePath(),
        idempotencyKey: "cli-assistant:redacted",
        beforeMessageWrite,
        message: createExactAssistantMessage({ text: "secret output" }),
      });

    const first = await append();
    const replay = await append();

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(beforeMessageWrite).toHaveBeenCalledOnce();
    if (!first.ok) {
      throw new Error("expected assistant append to succeed");
    }
    const messages = fs
      .readFileSync(first.sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: ExactAssistantMessage })
      .flatMap((entry) => (entry.message ? [entry.message] : []));
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "[redacted by hook]" }],
        idempotencyKey: "cli-assistant:redacted",
      }),
    ]);
  });

  it("dedupes unkeyed delivery mirrors after before_message_write rewrites", async () => {
    writeTranscriptStore();
    const beforeMessageWrite = vi.fn(({ message }: BeforeMessageWriteParams) => ({
      ...message,
      content: [{ type: "text" as const, text: "[redacted by hook]" }],
    }));
    const append = () =>
      appendAssistantMessageToSessionTranscript({
        sessionKey,
        storePath: fixture.storePath(),
        text: "secret output",
        beforeMessageWrite,
      });

    const first = await append();
    const replay = await append();

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(beforeMessageWrite).toHaveBeenCalledTimes(2);
    if (!first.ok) {
      throw new Error("expected delivery mirror append to succeed");
    }
    const messages = fs
      .readFileSync(first.sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: ExactAssistantMessage })
      .flatMap((entry) => (entry.message ? [entry.message] : []));
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "[redacted by hook]" }],
      }),
    ]);
  });

  it("reports assistant messages blocked by before_message_write", async () => {
    writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      agentId: "main",
      sessionKey,
      storePath: fixture.storePath(),
      idempotencyKey: "cli-assistant:blocked",
      beforeMessageWrite: vi.fn(() => null),
      message: createExactAssistantMessage({ text: "secret output" }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "blocked",
    });
  });

  it("rejects assistant output after the session key is rebound", async () => {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId: "replacement-session",
          chatType: "direct",
        },
      }),
      "utf-8",
    );

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      expectedSessionId: sessionId,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "late output" }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "session-rebound",
    });
    expect(
      fs.existsSync(
        resolveSessionTranscriptPathInDir("replacement-session", fixture.sessionsDir()),
      ),
    ).toBe(false);
  });

  it("rejects a concurrent session rebind before the assistant append", async () => {
    writeTranscriptStore();
    let releaseReset = () => {};
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let markResetStarted = () => {};
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    const replacementSessionFile = resolveSessionTranscriptPathInDir(
      "replacement-session",
      fixture.sessionsDir(),
    );
    const reset = updateSessionStoreEntry({
      storePath: fixture.storePath(),
      sessionKey,
      update: async () => {
        markResetStarted();
        await resetGate;
        return {
          sessionId: "replacement-session",
          sessionFile: replacementSessionFile,
        };
      },
    });
    await resetStarted;

    const append = appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      expectedSessionId: sessionId,
      storePath: fixture.storePath(),
      message: createExactAssistantMessage({ text: "late output" }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseReset();

    await reset;
    const result = await append;
    expect(result).toMatchObject({
      ok: false,
      code: "session-rebound",
    });
    expect(fs.existsSync(replacementSessionFile)).toBe(false);
  });

  it("dedupes concurrent exact assistant appends by idempotency key", async () => {
    writeTranscriptStore();
    const idempotencyKey = "mirror:concurrent-assistant";

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        appendExactAssistantMessageToSessionTranscript({
          sessionKey,
          storePath: fixture.storePath(),
          idempotencyKey,
          updateMode: "none",
          message: createExactAssistantMessage({
            text: "Mirrored reply",
            provider: "openclaw",
            model: "delivery-mirror",
          }),
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    const messageIds = results.map((result) => (result.ok ? result.messageId : ""));
    expect(new Set(messageIds).size).toBe(1);

    const firstOk = results.find((result) => result.ok);
    if (!firstOk?.ok) {
      throw new Error("expected exact assistant append to succeed");
    }
    const records = fs
      .readFileSync(firstOk.sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: { role?: string; idempotencyKey?: string } })
      .filter(
        (record) =>
          record.message?.role === "assistant" && record.message.idempotencyKey === idempotencyKey,
      );
    expect(records).toHaveLength(1);
  });

  it("can emit file-only transcript refresh events for exact assistant appends", async () => {
    writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      updateMode: "file-only",
      message: createExactAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledWith({
        sessionFile: result.sessionFile,
        sessionKey,
      });
    }
    emitSpy.mockRestore();
  });

  it("serializes concurrent parent-linked transcript appends", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "concurrent-tree-session",
      fixture.sessionsDir(),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "concurrent-tree-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "root-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "root" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendSessionTranscriptMessage({
          transcriptPath: sessionFile,
          message: { role: "assistant", content: `reply ${index}` },
        }),
      ),
    );

    const records = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { content?: string };
          },
      )
      .filter((record) => record.type === "message");

    expect(records).toHaveLength(9);
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index]?.parentId).toBe(records[index - 1]?.id);
    }
  });

  it("separates message and event appends from an unterminated transcript entry", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: fixture.sessionsDir(),
        }),
        JSON.stringify({
          type: "message",
          id: "existing",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "existing" },
        }),
      ].join("\n"),
      "utf8",
    );

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "appended message" },
    });
    fs.writeFileSync(sessionFile, fs.readFileSync(sessionFile, "utf8").trimEnd(), "utf8");
    await appendSessionTranscriptEvent({
      transcriptPath: sessionFile,
      event: { type: "custom", id: "event", parentId: null },
    });

    const entries = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message", "custom"]);
  });

  it("serializes transcript events before inspecting the append separator", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const replacementHeader = JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-06-15T00:00:00.000Z",
      cwd: fixture.sessionsDir(),
    });
    fs.writeFileSync(sessionFile, `${replacementHeader}\n`, "utf8");

    await appendSessionTranscriptEvent({
      transcriptPath: sessionFile,
      event: {
        type: "custom",
        toJSON() {
          fs.writeFileSync(sessionFile, replacementHeader, "utf8");
          return { type: "custom", id: "serialized-first", parentId: null };
        },
      },
    });

    const entries = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; id?: string });
    expect(entries).toEqual([
      expect.objectContaining({ type: "session", id: sessionId }),
      { type: "custom", id: "serialized-first", parentId: null },
    ]);
  });

  it("requires explicit idempotency scanning for direct transcript appends", async () => {
    const uncheckedSessionFile = resolveSessionTranscriptPathInDir(
      "unchecked-idempotency-session",
      fixture.sessionsDir(),
    );
    const checkedSessionFile = resolveSessionTranscriptPathInDir(
      "checked-idempotency-session",
      fixture.sessionsDir(),
    );
    const message = {
      role: "assistant",
      content: "fresh keyed append",
      idempotencyKey: "fresh-key",
    };

    await appendSessionTranscriptMessage({
      transcriptPath: uncheckedSessionFile,
      message,
    });
    const uncheckedSecondAppend = await appendSessionTranscriptMessage({
      transcriptPath: uncheckedSessionFile,
      message,
    });

    const checkedFirstAppend = await appendSessionTranscriptMessage({
      transcriptPath: checkedSessionFile,
      message,
      idempotencyLookup: "scan",
    });
    const checkedSecondAppend = await appendSessionTranscriptMessage({
      transcriptPath: checkedSessionFile,
      message,
      idempotencyLookup: "scan",
    });

    const countMessages = (sessionFile: string) =>
      fs
        .readFileSync(sessionFile, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((record) => record.type === "message").length;

    expect(uncheckedSecondAppend.appended).toBe(true);
    expect(countMessages(uncheckedSessionFile)).toBe(2);
    expect(checkedSecondAppend.appended).toBe(false);
    expect(checkedSecondAppend.messageId).toBe(checkedFirstAppend.messageId);
    expect(countMessages(checkedSessionFile)).toBe(1);
  });

  it("falls back instead of throwing for out-of-range append timestamps", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "invalid-now-transcript-session",
      fixture.sessionsDir(),
    );
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00Z"));

    try {
      await appendSessionTranscriptMessage({
        transcriptPath: sessionFile,
        message: { role: "user", content: "bad clock append" },
        now: 8_640_000_000_000_001,
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    const message = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            timestamp?: string;
          },
      )
      .find((record) => record.type === "message");

    expect(message?.timestamp).toBe("2026-05-30T12:00:00.000Z");
  });

  it("appends after the target selected by a leaf control record", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "leaf-target-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: rootEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "abandoned answer" },
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-05-30T12:00:02.000Z",
      targetId: rootEntry.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "leaf-target-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        abandonedEntry,
        leafEntry,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(rootEntry.id);
  });

  it("appends after an explicit opaque append parent on a leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "leaf-append-parent-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: rootEntry.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "leaf-append-parent-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        metadata,
        {
          type: "leaf",
          id: "leaf-1",
          parentId: metadata.id,
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: rootEntry.id,
          appendParentId: metadata.id,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(metadata.id);
  });

  it("marks transcript-only messages that consume a side append cursor", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "side-append-mode-transcript-session",
      fixture.sessionsDir(),
    );
    const activeEntry = {
      type: "message",
      id: "active-entry",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "active question" },
    };
    const sideEntry = {
      type: "message",
      id: "side-entry",
      parentId: activeEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "first side delivery" },
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "side-append-mode-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        activeEntry,
        sideEntry,
        {
          type: "leaf",
          id: "side-leaf",
          parentId: sideEntry.id,
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: activeEntry.id,
          appendParentId: sideEntry.id,
          appendMode: "side",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: "second side delivery",
      },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            id?: string;
            parentId?: string | null;
            appendMode?: string;
          },
      )
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry).toMatchObject({
      parentId: sideEntry.id,
      appendMode: "side",
    });

    const nextUser = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "user", content: "next question" },
    });
    const finalRecords = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(finalRecords.find((entry) => entry.id === nextUser.messageId)).toMatchObject({
      parentId: appended.messageId,
    });
    expect(finalRecords.find((entry) => entry.id === nextUser.messageId)).not.toHaveProperty(
      "appendMode",
    );
    expect(
      selectSessionTranscriptLeafControlledPath(finalRecords)?.map((entry) => entry.id),
    ).toEqual([activeEntry.id, nextUser.messageId]);
  });

  it("ignores dangling leaf references when choosing the direct append parent", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "invalid-leaf-append-parent-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: rootEntry.id,
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "invalid-leaf-append-parent-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        metadata,
        {
          type: "leaf",
          id: "missing-target",
          parentId: metadata.id,
          timestamp: "2026-05-30T12:00:01.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: rootEntry.id,
          appendParentId: "missing",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(metadata.id);
  });

  it("rejects append targets that reference an earlier invalid leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "nested-invalid-leaf-append-parent-transcript-session",
      fixture.sessionsDir(),
    );
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "root question" },
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "nested-invalid-leaf-append-parent-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        rootEntry,
        {
          type: "leaf",
          id: "invalid-leaf",
          parentId: rootEntry.id,
          timestamp: "2026-05-30T12:00:01.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "nested-invalid-leaf",
          parentId: "invalid-leaf",
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: "invalid-leaf",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "replacement answer" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(rootEntry.id);
  });

  it("recognizes parentless canonical rows selected by a later leaf control", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "parentless-leaf-target-transcript-session",
      fixture.sessionsDir(),
    );
    const activeEntry = {
      type: "message",
      id: "active-entry",
      timestamp: "2026-05-30T12:00:00.000Z",
      message: { role: "user", content: "active question" },
    };
    const sideEntry = {
      type: "message",
      id: "side-entry",
      parentId: activeEntry.id,
      timestamp: "2026-05-30T12:00:01.000Z",
      message: { role: "assistant", content: "side delivery" },
    };
    fs.writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "parentless-leaf-target-transcript-session",
          timestamp: "2026-05-30T12:00:00.000Z",
          cwd: fixture.sessionsDir(),
        },
        activeEntry,
        sideEntry,
        {
          type: "leaf",
          id: "active-leaf",
          parentId: sideEntry.id,
          timestamp: "2026-05-30T12:00:02.000Z",
          targetId: activeEntry.id,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "active replacement" },
    });

    const appendedEntry = fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === appended.messageId);
    expect(appendedEntry?.parentId).toBe(activeEntry.id);
  });

  it("redacts structured message content before transcript persistence", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redacted-transcript-session",
      fixture.sessionsDir(),
    );

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "standalone app password abcd-efgh-ijkl-mnop",
          },
          {
            type: "text",
            text: "tokens ya29.fake-access-token-with-enough-length",
          },
        ],
        toolInput: {
          apiKey: "AIzaSyD-very-real-looking-google-api-key-123",
          refresh: "1//0fake-refresh-token-with-enough-length",
        },
      },
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("ya29.fake-access-token");
    expect(raw).not.toContain("abcd-efgh-ijkl-mnop");
    expect(raw).not.toContain("AIzaSyD-very-real-looking");
    expect(raw).not.toContain("1//0fake-refresh-token");
  });

  it("migrates small linear transcripts before appending", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "small-linear-session",
      fixture.sessionsDir(),
    );
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "small-linear-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-first",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "legacy first" },
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-second",
          timestamp: new Date().toISOString(),
          message: { role: "assistant", content: "legacy second" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const appended = await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: { role: "assistant", content: "new reply" },
    });

    const records = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { content?: string };
          },
      );
    const messages = records.filter((record) => record.type === "message");

    expect(messages.map((record) => record.message?.content)).toEqual([
      "legacy first",
      "legacy second",
      "new reply",
    ]);
    expect(messages[0]?.id).toBe("legacy-first");
    expect(messages[0]?.parentId).toBeNull();
    expect(messages[1]?.id).toBe("legacy-second");
    expect(messages[1]?.parentId).toBe("legacy-first");
    expect(messages[2]?.id).toBe(appended.messageId);
    expect(messages[2]?.parentId).toBe("legacy-second");
  });
});
