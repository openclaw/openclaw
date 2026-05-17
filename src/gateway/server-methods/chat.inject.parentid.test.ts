import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  appendInjectedAssistantMessageToTranscript,
  appendInjectedUserMessageToTranscript,
} from "./chat-transcript-inject.js";
import { createTranscriptFixtureSync } from "./chat.test-helpers.js";

function readTranscriptLines(transcriptPath: string): string[] {
  const lines: string[] = [];
  for (const line of fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/)) {
    if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

// Guardrail: Gateway-injected assistant transcript messages must attach to the
// current leaf with a `parentId` and must not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a Pi session entry that includes parentId", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-",
      sessionId: "sess-1",
    });

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "hello",
      });
      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");
      const messageId = appended.messageId;
      if (!messageId) {
        throw new Error("expected appended message id");
      }
      expect(messageId.length).toBeGreaterThan(0);

      const lines = readTranscriptLines(transcriptPath);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
      expect(last.type).toBe("message");

      // The regression we saw: raw jsonl appends omitted this field entirely.
      expect(Object.prototype.hasOwnProperty.call(last, "parentId")).toBe(true);
      expect(last).toHaveProperty("id");
      expect(last).toHaveProperty("message");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses raw append for oversized append-only transcripts", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-large-",
      sessionId: "sess-1",
    });

    try {
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: "legacy-large-message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          },
        })}\n`,
        "utf-8",
      );

      const appended = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "hello",
      });
      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");
      const messageId = appended.messageId;
      if (!messageId) {
        throw new Error("expected appended message id");
      }
      expect(messageId.length).toBeGreaterThan(0);

      const lines = readTranscriptLines(transcriptPath);
      const last = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;

      expect(last.type).toBe("message");
      expect(last).toHaveProperty("id", messageId);
      expect(last).toHaveProperty("message");
      expect(Object.prototype.hasOwnProperty.call(last, "parentId")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits and returns the redacted injected assistant message", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-redact-",
      sessionId: "sess-redact",
    });
    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const updates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: `Here is your key: ${fakeApiKey}`,
        config: { logging: { redactSensitive: "tools" } },
      });

      expect(appended.ok).toBe(true);
      expect(JSON.stringify(appended.message)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);

      const lines = readTranscriptLines(transcriptPath);
      const last = JSON.parse(lines.at(-1) as string) as { message?: unknown };
      expect(JSON.stringify(last.message)).not.toContain(fakeApiKey);
      expect(updates[0]?.message).toEqual(last.message);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends an injected user message", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-user-",
      sessionId: "sess-user",
    });

    try {
      const appended = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "hello from user",
      });

      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");

      const lines = readTranscriptLines(transcriptPath);
      const last = JSON.parse(lines.at(-1) as string) as {
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      expect(last.message?.role).toBe("user");
      expect(last.message?.content?.[0]?.type).toBe("text");
      expect(last.message?.content?.[0]?.text).toBe("hello from user");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes concurrent identical idempotent injects (race-safe)", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-race-",
      sessionId: "sess-race",
    });

    try {
      const idempotencyKey = "race-key-001";
      const concurrency = 16;
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          appendInjectedUserMessageToTranscript({
            transcriptPath,
            message: "concurrent hello",
            idempotencyKey,
          }),
        ),
      );

      // Every call must succeed and return the same canonical messageId.
      const messageIds = new Set<string>();
      let dedupedCount = 0;
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.messageId).toBeTypeOf("string");
        messageIds.add(r.messageId as string);
        if (r.deduped) {
          dedupedCount += 1;
        }
      }
      expect(messageIds.size).toBe(1);
      // Exactly one call writes; the rest must be deduped.
      expect(dedupedCount).toBe(concurrency - 1);

      // Disk state must reflect a single persisted entry for the key.
      const lines = readTranscriptLines(transcriptPath);
      const matches = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
          return parsed?.message?.idempotencyKey === idempotencyKey;
        } catch {
          return false;
        }
      });
      expect(matches).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the original persisted payload on idempotent replay", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-replay-",
      sessionId: "sess-replay",
    });

    try {
      const idempotencyKey = "replay-key-001";
      const first = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "first payload wins",
        idempotencyKey,
      });
      const replay = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "second payload should be ignored",
        idempotencyKey,
      });

      expect(first.ok).toBe(true);
      expect(replay.ok).toBe(true);
      expect(replay.deduped).toBe(true);
      expect(replay.messageId).toBe(first.messageId);
      expect(
        (replay.message as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text,
      ).toBe("first payload wins");

      const lines = readTranscriptLines(transcriptPath);
      const messages: Array<{
        type?: string;
        message?: { content?: Array<{ text?: string }> };
      }> = lines
        .map(
          (line) =>
            JSON.parse(line) as { type?: string; message?: { content?: Array<{ text?: string }> } },
        )
        .filter((entry) => entry.type === "message");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.message?.content?.[0]?.text).toBe("first payload wins");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not deduplicate when no idempotencyKey is provided", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-nokey-",
      sessionId: "sess-nokey",
    });

    try {
      const first = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "hello no key",
      });
      const second = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "hello no key",
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      // Without an idempotency key, both writes must land on disk.
      expect(first.deduped).toBeFalsy();
      expect(second.deduped).toBeFalsy();
      expect(first.messageId).not.toBe(second.messageId);

      const lines = readTranscriptLines(transcriptPath);
      const messages = lines
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((e) => e.type === "message");
      expect(messages).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not emit a transcript update event on idempotent replay", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-noevent-",
      sessionId: "sess-noevent",
    });
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((u) => updates.push(u));

    try {
      const idempotencyKey = "noevent-key-001";
      await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "original",
        idempotencyKey,
      });
      const eventCountAfterFirst = updates.length;

      await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "replay - should not emit",
        idempotencyKey,
      });

      // First write must have emitted exactly one event.
      expect(eventCountAfterFirst).toBe(1);
      // Replay must not emit any additional events.
      expect(updates).toHaveLength(1);
    } finally {
      unsubscribe();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates assistant-role injects by idempotency key", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-asst-dedup-",
      sessionId: "sess-asst-dedup",
    });

    try {
      const idempotencyKey = "asst-dedup-key-001";
      const first = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "assistant first payload",
        idempotencyKey,
      });
      const replay = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "assistant second payload - must be ignored",
        idempotencyKey,
      });

      expect(first.ok).toBe(true);
      expect(first.deduped).toBeFalsy();
      expect(replay.ok).toBe(true);
      expect(replay.deduped).toBe(true);
      expect(replay.messageId).toBe(first.messageId);

      // Only one entry on disk.
      const lines = readTranscriptLines(transcriptPath);
      const messages = lines
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((e) => e.type === "message");
      expect(messages).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinct idempotency keys produce distinct entries", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-multikey-",
      sessionId: "sess-multikey",
    });

    try {
      const r1 = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "message for key A",
        idempotencyKey: "key-A",
      });
      const r2 = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "message for key B",
        idempotencyKey: "key-B",
      });
      // Replay key A - must not collide with key B.
      const r1replay = await appendInjectedUserMessageToTranscript({
        transcriptPath,
        message: "key A replay",
        idempotencyKey: "key-A",
      });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1.deduped).toBeFalsy();
      expect(r2.deduped).toBeFalsy();
      expect(r1.messageId).not.toBe(r2.messageId);

      expect(r1replay.deduped).toBe(true);
      expect(r1replay.messageId).toBe(r1.messageId);

      // Two distinct entries on disk.
      const lines = readTranscriptLines(transcriptPath);
      const messages = lines
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((e) => e.type === "message");
      expect(messages).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
