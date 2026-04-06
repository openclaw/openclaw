import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PointerContextEngine } from "./pointer.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeUserMsg(text: string, timestamp = Date.now()): UserMessage {
  return { role: "user", content: text, timestamp };
}

function makeAssistantMsg(text: string, timestamp = Date.now()): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "anthropic",
    model: "test-model",
    stopReason: "stop",
    timestamp,
    usage: ZERO_USAGE,
  };
}

function seedSession(sessionFile: string, turnCount: number): SessionManager {
  fs.writeFileSync(sessionFile, "");
  const sm = SessionManager.open(sessionFile);
  for (let i = 0; i < turnCount; i++) {
    sm.appendMessage(makeUserMsg(`User message ${i + 1}`));
    sm.appendMessage(makeAssistantMsg(`Assistant response ${i + 1}`));
  }
  return sm;
}

describe("PointerContextEngine", () => {
  let tmpDir: string;
  let engine: PointerContextEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-test-"));
    engine = new PointerContextEngine();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips compaction when under budget", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    seedSession(sessionFile, 5);

    const result = await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 1_000_000, // very large budget
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("within budget");
  });

  it("compacts when forced even if under budget", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    seedSession(sessionFile, 15);

    const result = await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 1_000_000,
      force: true,
      runtimeContext: {
        config: {
          agents: { defaults: { compaction: { hotTailTurns: 5 } } },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toContain("📌");
    expect(result.result?.summary).toContain("compacted");
    expect(result.result?.tokensAfter).toBeLessThan(result.result!.tokensBefore);
  });

  it("preserves hot tail turns", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    seedSession(sessionFile, 20);

    const result = await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 100,
      force: true,
      runtimeContext: {
        config: {
          agents: { defaults: { compaction: { hotTailTurns: 5 } } },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    // After compaction, re-read the session and verify the last 5 turn pairs survive
    const sm = SessionManager.open(sessionFile);
    const branch = sm.getBranch() as Array<{
      type: string;
      message?: { role: string; content: unknown };
    }>;
    const msgs = branch.filter((e) => e.type === "message" && e.message);

    // Last messages should still be the original hot tail content
    const lastUserMsgs = msgs
      .filter((e) => e.message?.role === "user")
      .map((e) => e.message?.content);
    expect(lastUserMsgs[lastUserMsgs.length - 1]).toBe("User message 20");
  });

  it("is idempotent when already compacted", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    seedSession(sessionFile, 15);

    // First compaction
    await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 100,
      force: true,
      runtimeContext: {
        config: {
          agents: { defaults: { compaction: { hotTailTurns: 5 } } },
        },
      },
    });

    // Second compaction — should be a no-op (compaction markers block further eviction)
    const result2 = await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 1_000_000,
    });

    expect(result2.ok).toBe(true);
    expect(result2.compacted).toBe(false);
  });

  it("handles empty sessions gracefully", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");
    SessionManager.open(sessionFile);

    const result = await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("includes topic hints in the marker", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "");
    const sm = SessionManager.open(sessionFile);

    // Add messages with tool calls for richer hints
    for (let i = 0; i < 15; i++) {
      sm.appendMessage(makeUserMsg(`Tell me about topic number ${i + 1} in great detail`));
      sm.appendMessage(makeAssistantMsg(`Here is information about topic ${i + 1}`));
    }

    const result = await engine.compact({
      sessionId: "test",
      sessionFile,
      tokenBudget: 100,
      force: true,
      runtimeContext: {
        config: {
          agents: { defaults: { compaction: { hotTailTurns: 3 } } },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    // Marker should contain topic hints derived from message content
    expect(result.result?.summary).toContain("Topics:");
  });

  describe("info", () => {
    it("identifies as pointer engine that owns compaction", () => {
      expect(engine.info.id).toBe("pointer");
      expect(engine.info.ownsCompaction).toBe(true);
    });
  });

  describe("assemble", () => {
    it("passes messages through unchanged", async () => {
      const msgs = [makeUserMsg("hello"), makeAssistantMsg("hi")] as Message[];
      const result = await engine.assemble({
        sessionId: "test",
        messages: msgs,
      });
      expect(result.messages).toBe(msgs);
    });
  });
});
