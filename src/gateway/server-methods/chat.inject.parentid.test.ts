// Chat transcript parent-id tests protect gateway-injected assistant appends so
// compaction history remains connected and transcript listeners receive updates.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
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

async function appendHelloAndRequireId(transcriptPath: string): Promise<string> {
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
  return messageId;
}

function readLastTranscriptRecord(transcriptPath: string): Record<string, unknown> {
  const lines = readTranscriptLines(transcriptPath);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  return JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
}

// Guardrail: Gateway-injected assistant transcript messages must attach to the
// current leaf with a `parentId` and must not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a agent session entry that includes parentId", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-",
      sessionId: "sess-1",
    });

    try {
      await appendHelloAndRequireId(transcriptPath);
      const last = readLastTranscriptRecord(transcriptPath);
      expect(last.type).toBe("message");

      // The regression we saw: raw jsonl appends omitted this field entirely.
      expect(Object.hasOwn(last, "parentId")).toBe(true);
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

      const messageId = await appendHelloAndRequireId(transcriptPath);
      const last = readLastTranscriptRecord(transcriptPath);

      expect(last.type).toBe("message");
      expect(last).toHaveProperty("id", messageId);
      expect(last).toHaveProperty("message");
      expect(Object.hasOwn(last, "parentId")).toBe(false);
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
    const updates: Array<{ message?: unknown; sessionKey?: string; agentId?: string }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        sessionKey: "global",
        agentId: "work",
        message: `Here is your key: ${fakeApiKey}`,
        config: { logging: { redactSensitive: "tools" } },
      });

      expect(appended.ok).toBe(true);
      expect(JSON.stringify(appended.message)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ sessionKey: "global", agentId: "work" });

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

  it("deduplicates concurrent keyed appends under the transcript write lock", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-idempotent-",
      sessionId: "sess-idempotent",
    });
    const updates: string[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionFile === transcriptPath) {
        updates.push(update.messageId);
      }
    });

    try {
      const append = () =>
        appendInjectedAssistantMessageToTranscript({
          transcriptPath,
          message: "durable fallback",
          idempotencyKey: "run-1:assistant-error",
        });
      const [first, second] = await Promise.all([append(), append()]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect([first.appended, second.appended].toSorted()).toEqual([false, true]);
      expect(second.messageId).toBe(first.messageId);
      const keyedRows = readTranscriptLines(transcriptPath)
        .map((line) => JSON.parse(line) as { message?: { idempotencyKey?: string } })
        .filter((record) => record.message?.idempotencyKey === "run-1:assistant-error");
      expect(keyedRows).toHaveLength(1);
      expect(updates).toEqual([first.messageId]);
    } finally {
      unsubscribe();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
