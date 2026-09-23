import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  captureNativeHistoryWindow,
  readNativeHistoryDiagnostic,
} from "../../scripts/lib/native-action-gateway-diagnostics.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const privateText = "private-fixture-path-token-and-payload";
function event(name: string, type: string, spanId: string, timestamp: number, attributes = {}) {
  return (
    JSON.stringify({
      schemaVersion: "openclaw.diagnostics.v1",
      name,
      type,
      spanId,
      timestamp: new Date(timestamp).toISOString(),
      runId: privateText,
      parentSpanId: privateText,
      attributes: { path: privateText, token: privateText, request: privateText, ...attributes },
      errorMessage: privateText,
    }) + "\n"
  );
}

function task(parentSpanId: string, timestamp: number, attributes: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      schemaVersion: "openclaw.diagnostics.v1",
      type: "mark",
      name: "worker.task",
      parentSpanId,
      timestamp: new Date(timestamp).toISOString(),
      attributes: {
        status: "captured",
        outcome: "ok",
        queueMs: 1,
        preparationMs: 2,
        runMs: 3,
        transferMs: 0.5,
        privateText,
        ...attributes,
      },
    }) + "\n"
  );
}

it("projects only history phases in the native window without exposing private fields", async () => {
  const file = path.join(temps.make("native-history-"), "timeline.jsonl");
  await fs.writeFile(file, privateText + "\n");
  const window = await captureNativeHistoryWindow(file);
  const at = window.startedAtMs;
  await fs.appendFile(
    file,
    [
      event("gateway.chat.history.session_entry", "span.start", privateText + "1", at + 1),
      event("gateway.chat.history.session_entry", "span.end", privateText + "1", at + 2),
      event("gateway.chat.history.history_page", "span.start", privateText + "2", at + 3),
      event("gateway.chat.history.startup_projection", "span.start", privateText + "3", at + 4),
      event("gateway.chat.history.startup_projection", "span.error", privateText + "3", at + 5),
      event("gateway.chat.history.session_info", "span.start", privateText + "4", at + 6),
      event("gateway.chat.history.session_info", "span.end", privateText + "4", at + 7),
      event(privateText, "span.start", privateText, at + 8),
      event("gateway.chat.history.history_page", "span.start", "before-window", at - 1),
      event("gateway.chat.history.history_page", "span.end", privateText + "2", at + 11),
    ].join(""),
  );
  const result = await readNativeHistoryDiagnostic(file, window, at + 10);
  expect(result).toEqual({
    readStatus: "captured",
    writerMayBeBuffered: true,
    cutoff: "through-native-process-failure",
    truncated: false,
    incompleteLine: false,
    malformedLine: false,
    orphanedTerminal: false,
    orphanedWorkerTask: false,
    spans: [
      { ordinal: 1, phase: "session_entry", startedMs: 1, finishedMs: 2, outcome: "end" },
      {
        ordinal: 2,
        phase: "history_page",
        startedMs: 3,
        finishedMs: null,
        outcome: "pending",
        request: { status: "unknown" },
        workerTasks: { rows: [], invalid: false, truncated: false },
      },
      { ordinal: 3, phase: "startup_projection", startedMs: 4, finishedMs: 5, outcome: "error" },
      { ordinal: 4, phase: "session_info", startedMs: 6, finishedMs: 7, outcome: "end" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(privateText);
  expect(JSON.stringify(result)).not.toContain(file);
});

it("binds interleaved worker marks privately and separates late pool completion from RPC success", async () => {
  const file = path.join(temps.make("native-history-workers-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  const at = window.startedAtMs;
  const phase = "gateway.chat.history.history_page";
  await fs.writeFile(
    file,
    [
      event(phase, "span.start", "first", at + 1, { requestId: privateText + "1" }),
      event(phase, "span.start", "second", at + 2, { requestId: privateText + "2" }),
      // The synthetic client times out at +10; native process failure is +20.
      task("second", at + 12),
      event(phase, "span.error", "second", at + 13),
      task("first", at + 15, { outcome: "failed" }),
      event(phase, "span.end", "first", at + 16),
      event(phase, "span.start", "coalesced-follower", at + 17),
      task("missing", at + 18),
      task("first", at + 19),
      task("coalesced-follower", at + 21),
    ].join(""),
  );
  const result = await readNativeHistoryDiagnostic(file, window, at + 20, (id) => ({
    status: "matched",
    connection: 2,
    request: id === privateText + "1" ? 3 : 4,
    raw: privateText,
  }));
  expect(result.spans[0]).toMatchObject({
    request: { status: "matched", connection: 2, request: 3 },
    outcome: "end",
    workerTasks: { rows: [{ ordinal: 1, finishedMs: 15, outcome: "failed" }] },
  });
  expect(result.spans[1]).toMatchObject({
    request: { status: "matched", connection: 2, request: 4 },
    outcome: "error",
    workerTasks: {
      rows: [{ ordinal: 1, finishedMs: 12, outcome: "ok", runMs: 3, transferMs: 0.5 }],
    },
  });
  expect(result.spans[2]).toMatchObject({
    request: { status: "unknown" },
    workerTasks: { rows: [] },
  });
  expect(result.orphanedWorkerTask).toBe(true);
  expect(result.cutoff).toBe("through-native-process-failure");
  expect(result.writerMayBeBuffered).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private|first|second|coalesced|missing|raw/);
});

it("preserves valid phase evidence when optional metrics or correlation are rejected", async () => {
  const file = path.join(temps.make("native-history-invalid-worker-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  const at = window.startedAtMs;
  const phase = "gateway.chat.history.history_page";
  await fs.writeFile(
    file,
    [
      event(phase, "span.start", "owner", at + 1, { requestId: privateText }),
      task("owner", at + 2, { runMs: -1 }),
      task("owner", at + 3, { status: "invalid" }),
      task("owner", at + 4, { status: "truncated" }),
      event(phase, "span.end", "owner", at + 5),
    ].join(""),
  );
  for (const match of [
    () => {
      throw new Error(privateText);
    },
    () => ({ status: "matched", connection: 5, request: 1 }),
  ]) {
    const result = await readNativeHistoryDiagnostic(file, window, at + 6, match);
    expect(result.spans).toEqual([
      {
        ordinal: 1,
        phase: "history_page",
        startedMs: 1,
        finishedMs: 5,
        outcome: "end",
        request: { status: "unknown" },
        workerTasks: { rows: [], invalid: true, truncated: true },
      },
    ]);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
  }
});

it("caps individual lines, total task rows and encoded output while retaining bounded phases", async () => {
  const file = path.join(temps.make("native-history-worker-limits-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  const at = window.startedAtMs;
  const phase = "gateway.chat.history.history_page";
  const chunks = [
    Buffer.from(JSON.stringify({ privateText: "x".repeat(16 * 1024) }) + "\n"),
    Buffer.from([0xff, 10]),
  ];
  for (let index = 0; index < 64; index++) {
    const id = `owner-${index}`;
    chunks.push(Buffer.from(event(phase, "span.start", id, at + 1, { requestId: privateText })));
    for (let row = 0; row < 6; row++) {
      chunks.push(
        Buffer.from(
          task(id, at + 2, {
            queueMs: Number.MAX_SAFE_INTEGER,
            preparationMs: Number.MAX_SAFE_INTEGER,
            runMs: Number.MAX_SAFE_INTEGER,
            transferMs: Number.MAX_SAFE_INTEGER,
          }),
        ),
      );
    }
    chunks.push(Buffer.from(event(phase, "span.end", id, at + 3)));
  }
  chunks.push(Buffer.from('{"partial":'));
  await fs.writeFile(file, Buffer.concat(chunks));
  const result = await readNativeHistoryDiagnostic(file, window, at + 4, () => ({
    status: "matched",
    connection: 4,
    request: 32,
  }));
  expect(result.spans).toHaveLength(64);
  expect(result.spans.every((span) => span.outcome === "end")).toBe(true);
  expect(result.spans.every((span) => (span.workerTasks?.rows.length ?? 0) <= 4)).toBe(true);
  expect(
    result.spans.reduce((sum, span) => sum + (span.workerTasks?.rows.length ?? 0), 0),
  ).toBeLessThanOrEqual(64);
  expect(result).toMatchObject({ truncated: true, malformedLine: true, incompleteLine: true });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
  expect(JSON.stringify(result)).not.toMatch(/private|owner-|partial/);
});

it("retains incomplete, malformed and unmatched terminal evidence as unknown", async () => {
  const file = path.join(temps.make("native-history-incomplete-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  await fs.writeFile(
    file,
    event("gateway.chat.history.history_page", "span.end", privateText, window.startedAtMs + 1) +
      "invalid json\n" +
      event(
        "gateway.chat.history.session_entry",
        "span.start",
        "partial",
        window.startedAtMs + 2,
      ).trimEnd(),
  );
  const result = await readNativeHistoryDiagnostic(file, window, window.startedAtMs + 3);
  expect(result).toMatchObject({
    readStatus: "captured",
    writerMayBeBuffered: true,
    incompleteLine: true,
    malformedLine: true,
    orphanedTerminal: true,
    spans: [{ ordinal: 1, phase: "history_page", startedMs: null, finishedMs: 1, outcome: "end" }],
  });
  expect(JSON.stringify(result)).not.toContain(privateText);
});

it("caps file bytes before parsing and separately caps retained span owners", async () => {
  const file = path.join(temps.make("native-history-bounded-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, "x"));
  expect(await readNativeHistoryDiagnostic(file, window, window.startedAtMs + 1)).toMatchObject({
    readStatus: "oversize",
    truncated: true,
    writerMayBeBuffered: true,
    spans: [],
  });
  await fs.writeFile(
    file,
    Array.from({ length: 65 }, (_, index) =>
      event(
        "gateway.chat.history.history_page",
        "span.start",
        `${privateText}${index}`,
        window.startedAtMs,
      ),
    ).join(""),
  );
  const result = await readNativeHistoryDiagnostic(file, window, window.startedAtMs + 1);
  expect(result.readStatus).toBe("captured");
  expect(result.truncated).toBe(true);
  expect(result.spans).toHaveLength(64);
  expect(result.spans.at(-1)?.ordinal).toBe(64);
  expect(JSON.stringify(result)).not.toContain(privateText);
});

it("distinguishes unavailable and changed files without claiming Gateway non-execution", async () => {
  const dir = temps.make("native-history-files-");
  const file = path.join(dir, "timeline.jsonl");
  const absent = await captureNativeHistoryWindow(file);
  expect(await readNativeHistoryDiagnostic(file, absent, Date.now())).toMatchObject({
    readStatus: "missing",
    writerMayBeBuffered: true,
    spans: [],
  });
  await fs.writeFile(file, "existing fixture setup\n");
  const present = await captureNativeHistoryWindow(file);
  await fs.rename(file, path.join(dir, "old.jsonl"));
  await fs.writeFile(file, "replacement file\n");
  expect(await readNativeHistoryDiagnostic(file, present, Date.now())).toMatchObject({
    readStatus: "changed-file",
    writerMayBeBuffered: true,
    spans: [],
  });
  const unavailable = await captureNativeHistoryWindow(dir);
  expect(await readNativeHistoryDiagnostic(dir, unavailable, Date.now())).toMatchObject({
    readStatus: "start-unavailable",
    writerMayBeBuffered: true,
    spans: [],
  });
});
