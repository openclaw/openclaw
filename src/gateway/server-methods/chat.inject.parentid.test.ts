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

  it("deduplicates against latest assistant message with matching text", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-dedup-",
      sessionId: "sess-dedup",
    });

    try {
      // Write a canonical assistant reply first (simulating what the agent's
      // session manager does during a normal turn).
      const firstAppend = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "Hello from assistant",
      });
      expect(firstAppend.ok).toBe(true);
      const firstMessageId = firstAppend.messageId;
      expect(firstMessageId).toBeTypeOf("string");

      // Attempt to inject the same text again. Should dedup and return the
      // existing message ID.
      const secondAppend = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "Hello from assistant",
      });
      expect(secondAppend.ok).toBe(true);
      // The second append should NOT write a new line but return the existing id.
      expect(secondAppend.messageId).toBe(firstMessageId);

      // Transcript should still have only the header + one assistant message.
      const lines = readTranscriptLines(transcriptPath);
      expect(lines).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still appends when latest assistant message has different text", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-diff-",
      sessionId: "sess-diff",
    });

    try {
      const firstAppend = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "First reply",
      });
      expect(firstAppend.ok).toBe(true);

      const secondAppend = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "Second reply",
      });
      expect(secondAppend.ok).toBe(true);
      expect(secondAppend.messageId).not.toBe(firstAppend.messageId);

      const lines = readTranscriptLines(transcriptPath);
      // header + 2 assistant messages
      expect(lines).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips non-message entries (e.g. openclaw.cache-ttl) when finding latest assistant text for dedup", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-cttl-",
      sessionId: "sess-cttl",
    });

    try {
      // Write the canonical assistant reply first.
      const canonical = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "Canonical reply",
      });
      expect(canonical.ok).toBe(true);

      // Simulate a cache-ttl custom entry written after the canonical reply
      // (as the agent's session manager does via appendCustomEntry).
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "custom",
          id: "ttl-marker",
          parentId: canonical.messageId,
          customType: "openclaw.cache-ttl",
          timestamp: new Date().toISOString(),
          data: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
        })}\n`,
        "utf-8",
      );

      // Now inject the same text. The cache-ttl entry should be skipped and
      // the dedup should still find the canonical reply.
      const second = await appendInjectedAssistantMessageToTranscript({
        transcriptPath,
        message: "Canonical reply",
      });
      expect(second.ok).toBe(true);
      expect(second.messageId).toBe(canonical.messageId);

      // Should still have header + canonical + cache-ttl (no new message).
      const lines = readTranscriptLines(transcriptPath);
      expect(lines).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
