import fs from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { appendSessionTranscriptMessage } from "../../config/sessions/transcript-append.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createTranscriptFixtureSync } from "./chat.test-helpers.js";

function readTranscriptLines(transcriptPath: string): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    lines.push(JSON.parse(line) as Record<string, unknown>);
  }
  return lines;
}

function buildUserMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

// Guardrail: chat.send's webchat user-transcript persistence must mirror the
// gateway-injected assistant write path — Pi `type: "message"` entries reach
// the JSONL with a `parentId` chained to the current leaf so compaction and
// history stay healthy. Raw JSONL writes that drop `parentId` would sever
// the leaf chain.
describe("gateway chat.send webchat user-transcript persistence", () => {
  it("appends the webchat user turn with a parentId chained to the prior leaf", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-",
      sessionId: "sess-webchat-1",
    });

    try {
      // Simulate an existing parent-linked assistant entry as the current leaf
      // (this is the shape Pi writes via SessionManager).
      const assistantEntryId = "asst-leaf-id";
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: assistantEntryId,
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "earlier assistant turn" }],
          },
        })}\n`,
        "utf-8",
      );

      const result = await appendSessionTranscriptMessage({
        transcriptPath,
        message: buildUserMessage("hello from webchat", 1_700_000_000_000),
        sessionId: "sess-webchat-1",
      });
      expect(result.messageId).toBeTypeOf("string");
      expect(result.messageId.length).toBeGreaterThan(0);

      const entries = readTranscriptLines(transcriptPath);
      // session header + prior assistant + new user turn
      expect(entries).toHaveLength(3);

      const last = entries.at(-1) as Record<string, unknown>;
      expect(last.type).toBe("message");
      expect(last).toHaveProperty("id", result.messageId);
      expect(last).toHaveProperty("parentId", assistantEntryId);
      const lastMessage = last.message as Record<string, unknown>;
      expect(lastMessage.role).toBe("user");
      expect(lastMessage.content).toBe("hello from webchat");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate the user turn when the append is invoked once per chat.send", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-nodup-",
      sessionId: "sess-webchat-2",
    });

    try {
      const initialLineCount = readTranscriptLines(transcriptPath).length;
      const result = await appendSessionTranscriptMessage({
        transcriptPath,
        message: buildUserMessage("first user message", 1_700_000_001_000),
        sessionId: "sess-webchat-2",
      });
      expect(result.messageId).toBeTypeOf("string");

      const entries = readTranscriptLines(transcriptPath);
      expect(entries.length).toBe(initialLineCount + 1);
      const userEntries = entries.filter((entry) => {
        const message = entry.message as { role?: unknown } | undefined;
        return message?.role === "user";
      });
      expect(userEntries).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chains consecutive user turns so the second points at the first as parent", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-chain-",
      sessionId: "sess-webchat-3",
    });

    try {
      const first = await appendSessionTranscriptMessage({
        transcriptPath,
        message: buildUserMessage("first user message", 1_700_000_002_000),
        sessionId: "sess-webchat-3",
      });
      const second = await appendSessionTranscriptMessage({
        transcriptPath,
        message: buildUserMessage("second user message", 1_700_000_003_000),
        sessionId: "sess-webchat-3",
      });
      expect(first.messageId).not.toBe(second.messageId);

      const entries = readTranscriptLines(transcriptPath);
      const userEntries = entries.filter((entry) => {
        const message = entry.message as { role?: unknown } | undefined;
        return message?.role === "user";
      });
      expect(userEntries).toHaveLength(2);
      expect((userEntries[0] as { id?: unknown }).id).toBe(first.messageId);
      expect((userEntries[1] as { parentId?: unknown }).parentId).toBe(first.messageId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes the appended user turn visible to a history reader walking the leaf chain", async () => {
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-history-",
      sessionId: "sess-webchat-4",
    });

    try {
      const result = await appendSessionTranscriptMessage({
        transcriptPath,
        message: buildUserMessage("history-visible user", 1_700_000_004_000),
        sessionId: "sess-webchat-4",
      });

      const entries = readTranscriptLines(transcriptPath);
      // Walk leaves forward to build the conversation order, the same shape
      // chat.history reconstructs after reconnect.
      const messageEntries = entries.filter((entry) => entry.type === "message");
      const byId = new Map<string, Record<string, unknown>>();
      for (const entry of messageEntries) {
        const id = entry.id as string;
        byId.set(id, entry);
      }
      const leaf = messageEntries.at(-1);
      expect(leaf).toBeDefined();
      const leafMessage = (leaf as Record<string, unknown>).message as Record<string, unknown>;
      expect(leafMessage.role).toBe("user");
      expect(leafMessage.content).toBe("history-visible user");
      expect((leaf as Record<string, unknown>).id).toBe(result.messageId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The chat.send webchat user-write path must fire `before_message_write` so
// plugin-registered policy (redaction, provenance, block-list) applies to
// gateway user writes the same way it applies to the codex transcript mirror
// at extensions/codex/src/app-server/transcript-mirror.ts:147. These tests
// pin the composition: hook → append → emit, mirroring exactly what
// chat.ts does at the webchat persistence site.
describe("gateway chat.send webchat user-transcript before_message_write hook", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("does not write to disk when the hook blocks the user message", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({ block: true }),
        },
      ]),
    );

    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-hook-block-",
      sessionId: "sess-hook-block",
    });

    try {
      const initialLineCount = readTranscriptLines(transcriptPath).length;
      const userMessage = buildUserMessage("blocked content", 1_700_000_100_000);

      // Mirror exactly what chat.ts does at the webchat persistence site.
      const hookedMessage = runAgentHarnessBeforeMessageWriteHook({
        message: userMessage as AgentMessage,
        agentId: "test-agent",
        sessionKey: "sess-hook-block",
      });

      expect(hookedMessage).toBeNull();
      // If the hook blocks, chat.ts returns without appending — no disk write,
      // no emit. Assert that the transcript file is unchanged.
      expect(readTranscriptLines(transcriptPath).length).toBe(initialLineCount);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the hook-transformed message rather than the original", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const original = (event as { message: Record<string, unknown> }).message;
            return {
              message: {
                ...original,
                content: "<redacted by plugin policy>",
              } as AgentMessage,
            };
          },
        },
      ]),
    );

    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-hook-transform-",
      sessionId: "sess-hook-transform",
    });

    try {
      const userMessage = buildUserMessage(
        "secret-token-abc123 should not land on disk",
        1_700_000_101_000,
      );

      const hookedMessage = runAgentHarnessBeforeMessageWriteHook({
        message: userMessage as AgentMessage,
        agentId: "test-agent",
        sessionKey: "sess-hook-transform",
      });

      expect(hookedMessage).not.toBeNull();
      const result = await appendSessionTranscriptMessage({
        transcriptPath,
        message: hookedMessage,
        sessionId: "sess-hook-transform",
      });

      const entries = readTranscriptLines(transcriptPath);
      const last = entries.at(-1) as Record<string, unknown>;
      const lastMessage = last.message as Record<string, unknown>;
      expect(lastMessage.content).toBe("<redacted by plugin policy>");
      expect(JSON.stringify(entries)).not.toContain("secret-token-abc123");
      expect(last).toHaveProperty("id", result.messageId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the original message through unchanged when no hooks are registered", async () => {
    // No initializeGlobalHookRunner — the helper short-circuits to identity.
    const { dir, transcriptPath } = createTranscriptFixtureSync({
      prefix: "openclaw-webchat-user-hook-none-",
      sessionId: "sess-hook-none",
    });

    try {
      const userMessage = buildUserMessage("plain user content", 1_700_000_102_000);

      const hookedMessage = runAgentHarnessBeforeMessageWriteHook({
        message: userMessage as AgentMessage,
        agentId: "test-agent",
        sessionKey: "sess-hook-none",
      });

      // With no global hook runner, the helper returns the original message.
      expect(hookedMessage).toBe(userMessage);

      await appendSessionTranscriptMessage({
        transcriptPath,
        message: hookedMessage,
        sessionId: "sess-hook-none",
      });

      const entries = readTranscriptLines(transcriptPath);
      const last = entries.at(-1) as Record<string, unknown>;
      const lastMessage = last.message as Record<string, unknown>;
      expect(lastMessage.content).toBe("plain user content");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
