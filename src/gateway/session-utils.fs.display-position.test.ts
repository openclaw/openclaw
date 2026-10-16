import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
import { collectSessionTranscriptMessages } from "./session-transcript-source-pages.js";

function activity(id: string, afterEntryId: string | null, startOrder: number) {
  return createNestedToolActivity({
    runId: "archive-run",
    scopeId: "archive-scope",
    afterEntryId,
    startOrder,
    toolCallId: id,
    toolName: "read",
    input: { file: "example.txt" },
    result: { content: [{ type: "text", text: "sanitized result" }] },
    isError: false,
    startedAt: 100 + startOrder,
    timestamp: 200 + startOrder,
  });
}

function entry(id: string, parentId: string | null, message: unknown) {
  return { type: "message", id, parentId, message };
}

function brokenActivity(id: string, startOrder: number, details: Record<string, unknown>) {
  const message = activity(id, "dispatch-anchor", startOrder);
  return { ...message, details: { ...message.details, ...details } };
}

function metadata(message: unknown) {
  return (message as { __openclaw: Record<string, unknown> })["__openclaw"];
}

const positions = (messages: unknown[]) =>
  messages.map((message) => metadata(message).transcriptPosition);

const timestamp = "2026-08-28T00:00:00.000Z";
const notice = "This turn ended before a reply.";
function custom(id: string, parentId: string, customType: string, display?: boolean) {
  const content = customType === "run-failed-before-reply" ? notice : "PRIVATE_REPORT";
  return { type: "custom_message", id, parentId, customType, content, display, timestamp };
}

function placement(afterRawSeq: number | null, startOrder: number) {
  return { afterRawSeq, scopeId: "archive-scope", startOrder };
}

function serialize(sessionId: string, records: unknown[]) {
  return [{ type: "session", version: 3, id: sessionId }, ...records]
    .map((record) => JSON.stringify(record))
    .join("\n");
}

let dir: string;
let storePath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-position-"));
  storePath = path.join(dir, "sessions.json");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeArchive(sessionId: string, records: unknown[]) {
  const file = path.join(dir, `${sessionId}.jsonl.reset.2026-08-28T00-00-00.000Z`);
  fs.writeFileSync(file, serialize(sessionId, records));
  return { file, reader: new ArchivedTranscriptReader({ sessionId, storePath }) };
}

test("keeps physical dispatch anchors across source pages, bounded recent, page, by-ID and around-ID reads", async () => {
  const sessionId = "nested-placement";
  const { reader } = writeArchive(sessionId, [
    entry("root", null, { role: "user", content: "prompt" }),
    entry("discarded", "root", { role: "assistant", content: "inactive branch" }),
    { type: "leaf", id: "dispatch-anchor", parentId: "discarded", targetId: "root" },
    entry("progress", "dispatch-anchor", { role: "assistant", content: "working" }),
    entry("fast", "progress", activity("fast", "dispatch-anchor", 1)),
    entry("slow", "fast", activity("slow", "dispatch-anchor", 0)),
    entry("later-progress", "slow", { role: "assistant", content: "still working" }),
    entry("later", "later-progress", activity("later", "fast", 2)),
    entry("unknown", "later", activity("unknown", "missing-anchor", 3)),
    entry("invalid", "unknown", brokenActivity("invalid", 4, { startOrder: -1 })),
    entry("missing", "invalid", brokenActivity("missing", 5, { afterEntryId: undefined })),
    custom("notice", "missing", "run-failed-before-reply", true),
    custom("hidden", "notice", "private-report", false),
    custom("missing-display", "hidden", "private-report"),
    custom("context", "missing-display", "openclaw.runtime-context", true),
    entry("final", "context", { role: "assistant", content: "done" }),
  ]);
  const full = await collectSessionTranscriptMessages(
    (_scope, options) =>
      reader.readSourcePage(options, {
        indexedSeq: -1,
        activeEventCount: 0,
        totalMessages: 0,
        generation: undefined,
        tailEventSeq: undefined,
        resetSeq: null,
      }),
    { sessionId },
    { mode: "full", reason: "archive placement" },
  );
  const recentOptions = { maxMessages: 8, maxLines: 12, maxBytes: 8 * 1024 * 1024 };
  const pageOptions = { offset: 0, maxMessages: 8 };
  const recent = await reader.readRecentWithStats(recentOptions);
  const bounded = await reader.readPage({ ...pageOptions, recentAtHead: recentOptions });
  const page = await reader.readPage(pageOptions);
  const source = recent.displaySource;
  const foundPage = { found: true, displaySource: source, totalMessages: 11 };

  expect(source).toEqual(expect.any(String));
  expect(source).not.toContain(dir);
  expect(full.map((message) => metadata(message).id)).toEqual(
    "root progress fast slow later-progress later unknown invalid missing notice final".split(" "),
  );
  const expected = [
    { source, rawSeq: 2 },
    { source, rawSeq: 5 },
    { source, rawSeq: 6, activity: placement(4, 1) },
    { source, rawSeq: 7, activity: placement(4, 0) },
    { source, rawSeq: 8 },
    { source, rawSeq: 9, activity: placement(6, 2) },
    ...[10, 11, 12, 13, 17].map((rawSeq) => ({ source, rawSeq })),
  ];
  expect(positions(full)).toEqual(expected);
  for (const result of [recent, bounded, page]) {
    expect(positions(result.messages)).toEqual(expected.slice(-8));
  }
  expect(recent.totalMessages).toBe(11);
  expect(page).toMatchObject({ totalMessages: 11, displaySource: source });
  const emptyTail = { maxMessages: 0, maxLines: 0, maxBytes: 1024 };
  const emptyPage = await reader.readPage({ offset: 0, maxMessages: 0, recentAtHead: emptyTail });
  expect(emptyPage).toMatchObject({ messages: [], totalMessages: 11, displaySource: source });
  expect(full.at(-2)).toMatchObject({
    role: "custom",
    customType: "run-failed-before-reply",
    content: notice,
    timestamp: Date.parse(timestamp),
  });
  for (const id of ["hidden", "missing-display", "context"]) {
    expect(await reader.readById(id)).toMatchObject({ found: false });
    expect(await reader.readAroundId({ messageId: id, maxMessages: 2 })).toMatchObject({
      found: false,
      messages: [],
    });
  }
  for (const message of full) {
    const id = metadata(message).id as string;
    const byId = await reader.readById(id);
    const around = await reader.readAroundId({ messageId: id, maxMessages: 2 });
    expect(byId).toMatchObject({ found: true, oversized: false });
    expect(positions([byId.message])).toEqual(positions([message]));
    expect(around).toMatchObject({ found: true, displaySource: source });
    expect(around.messages.find((row) => metadata(row).id === id)).toEqual(message);
  }
  for (const [messageId, direction, maxMessages, messages, offset] of [
    ["root", "older", 4, full.slice(0, 1), 10],
    ["final", "newer", 4, full.slice(-1), 0],
    ["progress", "newer", 2, full.slice(1, 3), 8],
    ["fast", "older", 2, full.slice(1, 3), 8],
    ["notice", "older", 1, full.slice(9, 10), 1],
    ["notice", "newer", 1, full.slice(9, 10), 1],
  ] as const) {
    const directionalPage = await reader.readAroundId({ messageId, direction, maxMessages });
    expect(directionalPage).toEqual(
      expect.objectContaining({ ...foundPage, hasOverreadContext: false, offset, messages }),
    );
  }
});

test("resolves a dispatch anchor before reset selection drops it and preserves a null anchor", async () => {
  const { reader } = writeArchive("reset-placement", [
    entry("old", null, { role: "user", content: "old prompt" }),
    { type: "reset", id: "reset", parentId: "old", timestamp },
    entry("kept", "reset", activity("kept", "old", 0)),
    entry("beginning", "kept", activity("beginning", null, 1)),
  ]);
  const page = await reader.readPage({ offset: 0, maxMessages: 10 });
  const source = page.displaySource;
  const ids = page.messages.map((message) => metadata(message).id);
  expect(ids).toEqual(["reset", "kept", "beginning"]);
  expect(positions(page.messages)).toEqual([
    { source, rawSeq: 3 },
    { source, rawSeq: 4, activity: placement(2, 0) },
    { source, rawSeq: 5, activity: placement(null, 1) },
  ]);
});

test.each(["index scan", "tail open", "tail read"] as const)(
  "rejects archive generation changes during %s without mixing payload and placement",
  async (phase) => {
    const sessionId = `generation-${phase.replace(" ", "-")}`;
    const root = entry("root", null, { role: "user", content: "a".repeat(70_000) });
    const control = { type: "metadata", id: "control", parentId: "root" };
    const nested = entry("nested", "root", activity("nested", "root", 0));
    const { file, reader } = writeArchive(sessionId, [root, control, nested]);
    fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    const readPage = () => reader.readPage({ offset: 0, maxMessages: 10 });
    if (phase !== "index scan") {
      await readPage();
    }
    const initialStat = fs.statSync(file);
    const replacement = serialize(sessionId, [control, root, nested]);
    let rewritten = false;
    const rewrite = () => {
      if (rewritten) {
        return;
      }
      rewritten = true;
      if (phase === "tail open") {
        fs.writeFileSync(`${file}.replacement`, replacement);
        fs.renameSync(`${file}.replacement`, file);
        fs.utimesSync(file, initialStat.atime, initialStat.mtime);
      } else {
        fs.writeFileSync(file, replacement);
      }
    };
    const opened: Awaited<ReturnType<typeof fs.promises.open>>[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (args[0] === file && phase === "tail open") {
        rewrite();
      }
      const handle = await realOpen(...args);
      opened.push(handle);
      if (args[0] !== file || phase === "tail open") {
        return handle;
      }
      const read = handle.read.bind(handle);
      type ReadArgs = [Buffer, number, number, number | null];
      const readChunk = async (...[buffer, offset, length, position]: ReadArgs) => {
        const result = await read(
          buffer,
          offset,
          phase === "tail read" ? Math.min(length, 16) : length,
          position,
        );
        rewrite();
        return result;
      };
      return new Proxy(handle, {
        get(target, property, receiver) {
          return property === "read" ? readChunk : Reflect.get(target, property, receiver);
        },
      });
    });
    const result =
      phase === "index scan" ? readPage() : reader.readRecentWithStats({ maxMessages: 10 });
    const failure = await result
      .catch((error: unknown) => error)
      .finally(() => openSpy.mockRestore());
    expect(rewritten).toBe(true);
    expect(failure).toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
    expect(failure).toMatchObject({ sessionId });
    expect(opened.every((handle) => handle.fd === -1)).toBe(true);
    const recovered = await readPage();
    expect(recovered.messages).toHaveLength(2);
    expect(metadata(recovered.messages[1]).transcriptPosition).toMatchObject({
      rawSeq: 4,
      activity: { afterRawSeq: 3 },
    });
  },
);
