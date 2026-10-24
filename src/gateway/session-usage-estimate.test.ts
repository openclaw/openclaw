import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readLatestSessionUsageFromTranscriptFileAsync } from "./session-utils.fs.js";

// Boundary scoping for the transcript chars estimate (#150579): content
// superseded by a compaction/reset stays in the append-only JSONL, and the
// estimate must cover only the live window after the latest boundary.

function writeTranscript(tmpDir: string, sessionId: string, lines: unknown[]): string {
  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return transcriptPath;
}

describe("readLatestSessionUsageFromTranscript estimate window", () => {
  let tmpDir: string;
  let storePath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-estimate-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterAll(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scopes the chars estimate to the window after the latest compaction (#150579)", async () => {
    const sessionId = "usage-compaction-window";
    const archivedText = "x".repeat(4000);
    const tailText = "short live tail";
    writeTranscript(tmpDir, sessionId, [
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      { type: "compaction" },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: tailText,
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    // The 4000-char archive is superseded history; only the live tail counts.
    expect(snapshot?.totalTokens).toBe(estimateTokensFromChars(estimateStringChars(tailText)));
    expect(snapshot?.totalTokensFresh).toBe(true);
  });

  test("a reset boundary also restarts the chars estimate (#150579)", async () => {
    const sessionId = "usage-reset-window";
    const archivedText = "y".repeat(4000);
    const tailText = "after reset";
    writeTranscript(tmpDir, sessionId, [
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      { type: "reset" },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: tailText,
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    expect(snapshot?.totalTokens).toBe(estimateTokensFromChars(estimateStringChars(tailText)));
  });

  test("a later per-call totalTokens snapshot still wins over any estimate (#150579)", async () => {
    const sessionId = "usage-snapshot-beats-estimate";
    writeTranscript(tmpDir, sessionId, [
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: "x".repeat(4000),
        },
      },
      { type: "compaction" },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: "tail",
          usage: { input: 1000, cacheRead: 234 },
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    expect(snapshot?.totalTokens).toBe(1234);
    expect(snapshot?.totalTokensFresh).toBe(true);
  });

  test("a compaction keeps the summary and the retained window it names (#150579)", async () => {
    const sessionId = "usage-compaction-retained-window";
    const archivedText = "x".repeat(4000);
    const retainedText = "r".repeat(2000);
    const summaryText = "s".repeat(500);
    const tailText = "short live tail";
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "m-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      {
        type: "message",
        id: "m-retained",
        message: { role: "user", content: retainedText },
      },
      {
        type: "compaction",
        id: "c-1",
        summary: summaryText,
        firstKeptEntryId: "m-retained",
        tokensBefore: 1000,
      },
      {
        type: "message",
        id: "m-tail",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: tailText,
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    // The archived 4000 chars are superseded, but the model still sees the
    // summary, the retained message, and the live tail.
    expect(snapshot?.totalTokens).toBe(
      estimateTokensFromChars(
        estimateStringChars(retainedText) +
          estimateStringChars(summaryText) +
          estimateStringChars(tailText),
      ),
    );
    expect(snapshot?.totalTokensFresh).toBe(true);
  });

  test("a reset keeps the retained tail named by firstKeptEntryId (#150579)", async () => {
    const sessionId = "usage-reset-retained-window";
    const archivedText = "y".repeat(4000);
    const retainedText = "k".repeat(1500);
    const tailText = "after reset";
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "r-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      { type: "message", id: "r-retained", message: { role: "user", content: retainedText } },
      { type: "reset", id: "reset-1", reason: "reset", firstKeptEntryId: "r-retained" },
      {
        type: "message",
        id: "r-tail",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: tailText,
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    expect(snapshot?.totalTokens).toBe(
      estimateTokensFromChars(estimateStringChars(retainedText) + estimateStringChars(tailText)),
    );
  });

  test("a boundary naming an unknown kept entry keeps only the summary (#150579)", async () => {
    const sessionId = "usage-compaction-unknown-kept";
    const archivedText = "z".repeat(4000);
    const summaryText = "s".repeat(500);
    const tailText = "tail";
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "u-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      {
        type: "compaction",
        id: "c-unknown",
        summary: summaryText,
        firstKeptEntryId: "not-in-transcript",
        tokensBefore: 1000,
      },
      {
        type: "message",
        id: "u-tail",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: tailText,
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    // Same fallback as the transcript tree selector: an unresolvable kept
    // target drops the pre-boundary window, but the summary still counts.
    expect(snapshot?.totalTokens).toBe(
      estimateTokensFromChars(estimateStringChars(summaryText) + estimateStringChars(tailText)),
    );
  });

  test("a summary-only window keeps its estimate right after compaction (#150579)", async () => {
    const sessionId = "usage-compaction-summary-only";
    const archivedText = "x".repeat(4000);
    const summaryText = "s".repeat(500);
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "so-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      {
        type: "compaction",
        id: "c-summary-only",
        summary: summaryText,
        firstKeptEntryId: "not-in-transcript",
        tokensBefore: 1000,
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    // No model-tagged assistant survives the cut and none has replied yet;
    // the summary alone is the live window and must still be estimated.
    expect(snapshot?.totalTokens).toBe(estimateTokensFromChars(estimateStringChars(summaryText)));
    expect(snapshot?.totalTokensFresh).toBe(true);
  });

  test("a compaction retaining only user messages keeps its estimate (#150579)", async () => {
    const sessionId = "usage-compaction-retained-user-only";
    const archivedText = "x".repeat(4000);
    const retainedText = "r".repeat(2000);
    const summaryText = "s".repeat(500);
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "uo-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      { type: "message", id: "uo-retained", message: { role: "user", content: retainedText } },
      {
        type: "compaction",
        id: "c-user-only",
        summary: summaryText,
        firstKeptEntryId: "uo-retained",
        tokensBefore: 1000,
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    expect(snapshot?.totalTokens).toBe(
      estimateTokensFromChars(estimateStringChars(retainedText) + estimateStringChars(summaryText)),
    );
    expect(snapshot?.totalTokensFresh).toBe(true);
  });

  test("a reset retaining only user text keeps its estimate (#150579)", async () => {
    const sessionId = "usage-reset-retained-user-only";
    const archivedText = "y".repeat(4000);
    const retainedText = "k".repeat(1500);
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "ro-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      { type: "message", id: "ro-retained", message: { role: "user", content: retainedText } },
      { type: "reset", id: "reset-user-only", reason: "reset", firstKeptEntryId: "ro-retained" },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    expect(snapshot?.totalTokens).toBe(estimateTokensFromChars(estimateStringChars(retainedText)));
    expect(snapshot?.totalTokensFresh).toBe(true);
  });

  test("a compaction naming a structural entry keeps the retained tail behind it (#150579)", async () => {
    const sessionId = "usage-compaction-structural-anchor";
    const archivedText = "x".repeat(4000);
    const retainedText = "u".repeat(2000);
    const summaryText = "s".repeat(500);
    const tailText = "short live tail";
    writeTranscript(tmpDir, sessionId, [
      {
        type: "message",
        id: "m-archived",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: archivedText,
        },
      },
      // A real overflow compaction names the bootstrap custom event ahead of
      // the retained user message; the entry has no message payload at all.
      { type: "custom", id: "bootstrap-1", customType: "bootstrap", content: "session init" },
      { type: "message", id: "m-retained", message: { role: "user", content: retainedText } },
      {
        type: "compaction",
        id: "c-1",
        summary: summaryText,
        firstKeptEntryId: "bootstrap-1",
        tokensBefore: 1000,
      },
      {
        type: "message",
        id: "m-tail",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          content: tailText,
        },
      },
    ]);

    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(sessionId, storePath);
    // The anchor carries no countable text, but the cut resolves at it, so
    // the retained user message survives along with the summary and tail.
    expect(snapshot?.totalTokens).toBe(
      estimateTokensFromChars(
        estimateStringChars(retainedText) +
          estimateStringChars(summaryText) +
          estimateStringChars(tailText),
      ),
    );
    expect(snapshot?.totalTokensFresh).toBe(true);
  });
});
