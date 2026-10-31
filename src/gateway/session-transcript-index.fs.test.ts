import fs from "node:fs";
import path from "node:path";
import * as fileReads from "@openclaw/fs-safe/advanced";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
import { createArchiveSourceSnapshotFixture } from "./session-transcript-archive.test-support.js";
import {
  readIndexedTranscriptEntries,
  readSessionTranscriptIndex,
} from "./session-transcript-index.fs.js";
import type {
  SessionTranscriptSourceCursor,
  SessionTranscriptSourceSnapshot,
} from "./session-transcript-read.types.js";
import * as recordParser from "./session-transcript-record-parser.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

vi.mock("./session-transcript-record-parser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-record-parser.js")>()),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes: string | Buffer | unknown[], separator = "\n") {
  const file = path.join(dirs.make("archive-index-"), "session.jsonl");
  const contents = Array.isArray(bytes)
    ? bytes.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join(separator)
    : bytes;
  await fs.promises.writeFile(file, contents);
  return file;
}

function message(id: string | undefined, content: string, parentId?: string | null, role = "user") {
  return JSON.stringify({ type: "message", id, parentId, message: { role, content } });
}

async function openIndex(file: string) {
  const index = (await readSessionTranscriptIndex(file, "test"))!;
  return {
    index,
    read: (entries = index.entries) => readIndexedTranscriptEntries(file, index, entries, "test"),
  };
}

function imageMessage(id: string, bytes: number) {
  return JSON.stringify({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "caption" },
        { type: "image", mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") },
      ],
    },
  });
}

test("keeps exact physical ranges across newline dialects and malformed UTF8", async () => {
  const valid = [
    message("first", "α🦞".repeat(18000)),
    message("invalid", "\ufffd"),
    message("", "blank raw id"),
    message(undefined, "no id"),
  ];
  const file = await fixture(
    Buffer.concat([
      Buffer.from(` \r\n${valid[0]}\r`),
      Buffer.from('{"type":"message","id":"invalid","message":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from(`"}}\n{malformed\r\n${valid[2]}\n${valid[3]}`),
    ]),
  );
  const { index, read } = await openIndex(file);
  expect((await read()).map(({ record, byteLength, id }) => [record, byteLength, id])).toEqual(
    valid.map((line, i) => [JSON.parse(line), Buffer.byteLength(line), ["first", "invalid"][i]]),
  );
  expect(index.entries.map((entry) => entry.rawId)).toEqual(["first", "invalid", "", undefined]);
});

test("keeps CRLF across chunk boundaries and physical duplicate-anchor cuts", async () => {
  const first = message("anchor", "x".repeat(65_535 - Buffer.byteLength(message("anchor", ""))));
  const activity = createNestedToolActivity({
    runId: "run",
    scopeId: "scope",
    afterEntryId: "anchor",
    startOrder: 1,
    toolCallId: "tool",
    toolName: "exec",
    input: "retained input",
    result: { content: [{ type: "text", text: "retained output" }] },
    isError: false,
    startedAt: 0,
    timestamp: 1,
  });
  const file = await fixture(
    [
      first,
      { type: "custom_message", id: "early", message: activity },
      message("anchor", "last anchor"),
      { type: "custom_message", id: "late", message: activity },
    ],
    "\r\n",
  );
  const { index, read } = await openIndex(file);
  const entries = await read();
  expect(entries).toHaveLength(4);
  expect(entries.filter(({ id }) => id === "anchor").map(({ record }) => record.message)).toEqual([
    JSON.parse(first).message,
    { role: "user", content: "last anchor" },
  ]);
  expect((await read([index.byId.get("anchor")!]))[0]?.record.message).toEqual({
    role: "user",
    content: "last anchor",
  });
  expect(index.entries.find(({ id }) => id === "anchor")?.seq).toBe(1);
  expect(entries[1]?.record.message).toEqual(activity);
  expect(entries[1]?.transcriptPosition.activity).toBeUndefined();
  expect(entries[3]?.transcriptPosition.activity).toEqual({
    afterRawSeq: 3,
    scopeId: "scope",
    startOrder: 1,
  });
});

test("batches a page and rejects a rewrite while its pinned descriptor is being read", async () => {
  const file = await fixture(Array.from({ length: 40 }, (_, i) => message(String(i), "body")));
  const { read } = await openIndex(file);
  const actual = fileReads.readFileWindowFully;
  const reads = vi.spyOn(fileReads, "readFileWindowFully");
  await expect(read()).resolves.toHaveLength(40);
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockImplementationOnce(async (handle, buffer, position) => {
    const bytes = await actual(handle, buffer, position);
    await fs.promises.appendFile(file, "\n" + message("new", "rewritten"));
    return bytes;
  });
  await expect(read()).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
  const updated = await openIndex(file);
  await expect(updated.read([updated.index.entries.at(-1)!])).resolves.toMatchObject([
    { record: { id: "new" } },
  ]);
});

const archiveSnapshot: SessionTranscriptSourceSnapshot = createArchiveSourceSnapshotFixture();

function sourcePage(reader: ArchivedTranscriptReader, cursor?: SessionTranscriptSourceCursor) {
  return reader.readSourcePage({ mode: "page", cursor }, archiveSnapshot);
}

test("prepares cold source pages incrementally before selecting the final archive branch and reset", async () => {
  const rows = Array.from({ length: 260 }, (_, index) =>
    message(`message-${index}`, `prompt ${index}`, index === 0 ? null : `message-${index - 1}`),
  );
  const file = await fixture([
    ...rows,
    { type: "leaf", id: "leaf", parentId: "message-259", targetId: "message-100" },
    { type: "reset", id: "reset", parentId: "message-100", firstKeptEntryId: "message-99" },
    message("after-reset", "new reply", "reset", "assistant"),
  ]);
  const reader = new ArchivedTranscriptReader({ sessionId: "test", exactArchivePath: file });
  const parse = vi.spyOn(recordParser, "parseTranscriptRecord");
  let page = await sourcePage(reader);
  expect(page).toMatchObject({
    messages: [],
    nextCursor: { kind: "archive", position: 0, path: file },
  });
  expect(parse.mock.calls.length).toBeLessThanOrEqual(128);
  const messages: unknown[] = [];
  let pulls = 0;
  while (page.nextCursor && pulls++ < 10) {
    parse.mockClear();
    page = await sourcePage(reader, page.nextCursor);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(128);
    messages.push(...page.messages);
  }
  expect(page.nextCursor).toBeUndefined();
  expect(messages).toMatchObject([
    { content: "prompt 99" },
    { content: "prompt 100" },
    { __openclaw: { kind: "reset", id: "reset" } },
    { content: "new reply" },
  ]);
});

test("rejects an oversized source line before decoding while retaining ordinary image recovery", async () => {
  const imageBytes = 6 * 1024 * 1024 + 1024;
  const file = await fixture(imageMessage("large-image", imageBytes));
  const reader = new ArchivedTranscriptReader({ sessionId: "test", exactArchivePath: file });
  const parse = vi.spyOn(recordParser, "parseTranscriptRecord");
  const reads = vi.spyOn(fileReads, "readFileWindowFully");
  const oversized = "Transcript source message exceeds the 8388608-byte page limit";
  await expect(sourcePage(reader)).rejects.toThrow(oversized);
  expect(parse).not.toHaveBeenCalled();
  expect(
    reads.mock.calls.reduce((bytes, [, buffer]) => bytes + buffer.length, 0),
  ).toBeLessThanOrEqual(8 * 1024 * 1024 + 1);
  await expect(reader.readById("large-image")).resolves.toMatchObject({
    found: true,
    oversized: false,
    message: {
      content: [{ text: "caption" }, { type: "image", omitted: true, bytes: imageBytes }],
    },
  });
  parse.mockClear();
  await expect(sourcePage(reader)).rejects.toThrow(oversized);
  await expect(reader.readById("large-image")).resolves.toMatchObject({ found: true });
  expect(parse).toHaveBeenCalledTimes(1);
});

test("source preparation does not wait for an ordinary archive index scan", async ({ signal }) => {
  const file = await fixture(message("first", "prompt"));
  const reader = new ArchivedTranscriptReader({ sessionId: "test", exactArchivePath: file });
  const started = createDeferred();
  const release = createDeferred();
  const actual = fileReads.readFileWindowFully;
  vi.spyOn(fileReads, "readFileWindowFully").mockImplementationOnce(async (...args) => {
    started.resolve();
    await release.promise;
    return actual(...args);
  });
  const ordinary = reader.readById("first");
  try {
    await withinTest(started.promise, signal);
    const pending = await withinTest(sourcePage(reader), signal);
    expect(pending).toMatchObject({ messages: [], nextCursor: { kind: "archive", position: 0 } });
    release.resolve();
    await expect(ordinary).resolves.toMatchObject({ found: true, message: { content: "prompt" } });
    await expect(sourcePage(reader, pending.nextCursor)).resolves.toMatchObject({
      messages: [{ content: "prompt" }],
      nextCursor: undefined,
    });
  } finally {
    release.resolve();
    await ordinary;
  }
});
