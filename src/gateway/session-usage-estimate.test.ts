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
});
