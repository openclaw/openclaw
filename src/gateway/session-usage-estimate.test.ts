import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readLatestSessionUsageFromTranscriptFileAsync } from "./session-utils.fs.js";

// Compaction/reset supersedes content without removing it from JSONL. Only the live window counts.
const assistant = (content: unknown) => ({
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  content,
});
const raw = (content: unknown) => ({ message: assistant(content) });
const entry = (id: string, message: unknown) => ({ type: "message", id, message });
const user = (id: string, content: unknown) => entry(id, { role: "user", content });
const estimate = (...texts: string[]) =>
  estimateTokensFromChars(texts.reduce((sum, text) => sum + estimateStringChars(text), 0));
const archive = (id: string, text: string) => entry(id, assistant(text));
const retainedRows = (prefix: string, boundary: unknown, liveTail?: string) => [
  archive(`${prefix}-archived`, archived),
  user(`${prefix}-retained`, retained),
  boundary,
  ...(liveTail === undefined ? [] : [archive(`${prefix}-tail`, liveTail)]),
];
const compact = (id: string, summary: string, firstKeptEntryId: string) => ({
  type: "compaction",
  id,
  summary,
  firstKeptEntryId,
  tokensBefore: 1000,
});
const reset = (id: string, firstKeptEntryId: string) => ({
  type: "reset",
  id,
  reason: "reset",
  firstKeptEntryId,
});
const archived = "x".repeat(4000);
const retained = "r".repeat(2000);
const summary = "s".repeat(500);
const tail = "short live tail";
const scenarios = [
  {
    name: "scopes the chars estimate to the window after the latest compaction",
    id: "usage-compaction-window",
    rows: [raw(archived), { type: "compaction" }, raw(tail)],
    expected: estimate(tail),
  },
  {
    name: "a reset boundary also restarts the chars estimate",
    id: "usage-reset-window",
    rows: [raw(archived), { type: "reset" }, raw("after reset")],
    expected: estimate("after reset"),
  },
  {
    name: "a later per-call totalTokens snapshot still wins over any estimate",
    id: "usage-snapshot-beats-estimate",
    rows: [
      raw(archived),
      { type: "compaction" },
      { message: { ...assistant("tail"), usage: { input: 1000, cacheRead: 234 } } },
    ],
    expected: 1234,
  },
  {
    name: "a compaction keeps the summary and the retained window it names",
    id: "usage-compaction-retained-window",
    rows: retainedRows("m", compact("c-1", summary, "m-retained"), tail),
    expected: estimate(retained, summary, tail),
  },
  {
    name: "a reset keeps the retained tail named by firstKeptEntryId",
    id: "usage-reset-retained-window",
    rows: retainedRows("r", reset("reset-1", "r-retained"), "after reset"),
    expected: estimate(retained, "after reset"),
  },
  {
    name: "an unknown kept target drops the archive but keeps the summary and live tail",
    id: "usage-compaction-unknown-kept",
    rows: [
      archive("u-archived", archived),
      compact("c-unknown", summary, "not-in-transcript"),
      archive("u-tail", "tail"),
    ],
    expected: estimate(summary, "tail"),
  },
  {
    name: "a summary-only window keeps its estimate right after compaction",
    id: "usage-compaction-summary-only",
    rows: [
      archive("so-archived", archived),
      compact("c-summary-only", summary, "not-in-transcript"),
    ],
    expected: estimate(summary),
  },
  {
    name: "a compaction retaining only user messages keeps its estimate",
    id: "usage-compaction-retained-user-only",
    rows: retainedRows("uo", compact("c-user-only", summary, "uo-retained")),
    expected: estimate(retained, summary),
  },
  {
    name: "a reset retaining only user text keeps its estimate",
    id: "usage-reset-retained-user-only",
    rows: retainedRows("ro", reset("reset-user-only", "ro-retained")),
    expected: estimate(retained),
  },
  {
    name: "a compaction naming a structural entry keeps the retained tail behind it",
    id: "usage-compaction-structural-anchor",
    rows: [
      archive("m-archived", archived),
      { type: "custom", id: "bootstrap-1", customType: "bootstrap", content: "session init" },
      user("m-retained", retained),
      compact("c-1", summary, "bootstrap-1"),
      archive("m-tail", tail),
    ],
    expected: estimate(retained, summary, tail),
  },
];

describe("readLatestSessionUsageFromTranscript estimate window", () => {
  let tmpDir: string;
  let storePath: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-estimate-"));
    storePath = path.join(tmpDir, "sessions.json");
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  test.each(scenarios)("$name (#150579)", async ({ id, rows, expected }) => {
    fs.writeFileSync(
      path.join(tmpDir, `${id}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join("\n"),
      "utf-8",
    );
    const snapshot = await readLatestSessionUsageFromTranscriptFileAsync(id, storePath);
    expect(snapshot?.totalTokens).toBe(expected);
    expect(snapshot?.totalTokensFresh).toBe(true);
  });
});
