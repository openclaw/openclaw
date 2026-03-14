/**
 * Regression tests for the hash-based memory flush dedup logic (#34222).
 *
 * These tests verify that:
 * - Duplicate MEMORY.md writes are prevented when the transcript hasn't changed
 * - Compaction events correctly signal completion status
 * - Post-flush hash is stored correctly for subsequent dedup checks
 * - Session reset clears hash, allowing the first flush after reset
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

// Inline computeContextHash to avoid importing memory-flush.js (which
// triggers the full agent import chain and hits the missing pi-ai/oauth
// package in test environments).  This mirrors the implementation in
// src/auto-reply/reply/memory-flush.ts exactly.
function computeContextHash(messages: Array<{ role?: string; content?: unknown }>): string {
  const userAssistant = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const tail = userAssistant.slice(-3);
  const payload = `${messages.length}:${tail.map((m, i) => `[${i}:${m.role ?? ""}]${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}`).join("\x00")}`;
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  return hash.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Reproduce the exact dedup decision logic from runMemoryFlushIfNeeded
// (agent-runner-memory.ts lines ~464-488) as a pure function for testing.
// ---------------------------------------------------------------------------

function shouldSkipFlushByHash(
  tailMessages: Array<{ role?: string; content?: unknown }>,
  previousHash: string | undefined,
): { skip: boolean; hash: string | undefined } {
  if (tailMessages.length === 0) {
    return { skip: false, hash: undefined };
  }
  const hash = computeContextHash(tailMessages);
  if (previousHash && hash === previousHash) {
    return { skip: true, hash };
  }
  return { skip: false, hash };
}

// Reproduce the compaction event handler logic from agent-runner-memory.ts
// (line ~561): determines if a compaction event should be counted.
function shouldMarkCompactionCompleted(eventData: {
  phase?: string;
  hasResult?: boolean;
  wasAborted?: boolean;
  willRetry?: boolean;
}): boolean {
  const phase = typeof eventData.phase === "string" ? eventData.phase : "";
  return phase === "end" && Boolean(eventData.hasResult) && !eventData.wasAborted;
}

// ---------------------------------------------------------------------------
// Hash-based dedup decision tests
// ---------------------------------------------------------------------------

describe("hash-based memory flush dedup", () => {
  const transcript = [
    { role: "user", content: "hello world" },
    { role: "assistant", content: "Hi there! How can I help?" },
  ];

  it("first flush — no previous hash, should NOT skip", () => {
    const result = shouldSkipFlushByHash(transcript, undefined);
    expect(result.skip).toBe(false);
    expect(result.hash).toBeDefined();
  });

  it("same transcript — hash matches, should skip", () => {
    const hash = computeContextHash(transcript);
    const result = shouldSkipFlushByHash(transcript, hash);
    expect(result.skip).toBe(true);
    expect(result.hash).toBe(hash);
  });

  it("different transcript — hash mismatch, should NOT skip", () => {
    const previousHash = computeContextHash(transcript);
    const changedTranscript = [...transcript, { role: "user", content: "tell me more" }];
    const result = shouldSkipFlushByHash(changedTranscript, previousHash);
    expect(result.skip).toBe(false);
    expect(result.hash).not.toBe(previousHash);
  });

  it("empty transcript tail — should NOT skip (degenerate case)", () => {
    const result = shouldSkipFlushByHash([], "somehash");
    expect(result.skip).toBe(false);
    expect(result.hash).toBeUndefined();
  });

  it("session reset clears hash — first flush after reset should NOT skip", () => {
    // After session reset, entry.memoryFlushContextHash is cleared to undefined
    const clearedHash: string | undefined = undefined;
    const result = shouldSkipFlushByHash(transcript, clearedHash);
    expect(result.skip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-flush hash storage correctness
// ---------------------------------------------------------------------------

describe("post-flush hash storage", () => {
  it("post-flush hash differs from pre-flush hash (flush appends messages)", () => {
    const preFlushTail = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const postFlushTail = [
      ...preFlushTail,
      // The flush run appends its own messages to the transcript
      { role: "user", content: "Write a memory summary" },
      { role: "assistant", content: "Memory updated for 2026-03-13" },
    ];

    const preHash = computeContextHash(preFlushTail);
    const postHash = computeContextHash(postFlushTail);

    // They must differ — storing pre-flush hash would cause dedup to
    // never match (the next check sees post-flush transcript)
    expect(preHash).not.toBe(postHash);
  });

  it("next dedup check matches stored post-flush hash when transcript unchanged", () => {
    const postFlushTail = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "Write a memory summary" },
      { role: "assistant", content: "Memory updated" },
    ];
    const storedHash = computeContextHash(postFlushTail);

    // On next run, if no new messages, the tail is identical
    const nextCheckResult = shouldSkipFlushByHash(postFlushTail, storedHash);
    expect(nextCheckResult.skip).toBe(true);
  });

  it("next dedup check does NOT match after new user messages arrive", () => {
    const postFlushTail = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Memory updated" },
    ];
    const storedHash = computeContextHash(postFlushTail);

    // User sends new messages → transcript changes
    const newTail = [
      ...postFlushTail,
      { role: "user", content: "What about tomorrow?" },
      { role: "assistant", content: "Let me check the calendar" },
    ];
    const nextCheckResult = shouldSkipFlushByHash(newTail, storedHash);
    expect(nextCheckResult.skip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compaction event handling (determines memoryCompactionCompleted flag)
// ---------------------------------------------------------------------------

describe("compaction event completion detection", () => {
  it("successful compaction (hasResult=true, wasAborted=false) → completed", () => {
    expect(
      shouldMarkCompactionCompleted({
        phase: "end",
        hasResult: true,
        wasAborted: false,
        willRetry: false,
      }),
    ).toBe(true);
  });

  it("willRetry=true with result → still completed (overflow recovery)", () => {
    expect(
      shouldMarkCompactionCompleted({
        phase: "end",
        hasResult: true,
        wasAborted: false,
        willRetry: true,
      }),
    ).toBe(true);
  });

  it("aborted compaction → NOT completed", () => {
    expect(
      shouldMarkCompactionCompleted({
        phase: "end",
        hasResult: true,
        wasAborted: true,
        willRetry: false,
      }),
    ).toBe(false);
  });

  it("no result (compaction failed) → NOT completed", () => {
    expect(
      shouldMarkCompactionCompleted({
        phase: "end",
        hasResult: false,
        wasAborted: false,
        willRetry: false,
      }),
    ).toBe(false);
  });

  it("old event format (missing hasResult/wasAborted) → NOT completed", () => {
    // Backward compatibility: old events without new fields should not
    // incorrectly mark compaction as completed
    expect(
      shouldMarkCompactionCompleted({
        phase: "end",
        willRetry: false,
      }),
    ).toBe(false);
  });

  it("start phase → NOT completed", () => {
    expect(
      shouldMarkCompactionCompleted({
        phase: "start",
        hasResult: true,
        wasAborted: false,
      }),
    ).toBe(false);
  });
});
