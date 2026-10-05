import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as fileReads from "@openclaw/fs-safe/advanced";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
import {
  readIndexedTranscriptEntries,
  readSessionTranscriptIndex,
  selectArchiveTranscriptEntries,
} from "./session-transcript-index.fs.js";
import * as recordParser from "./session-transcript-record-parser.js";
import {
  parseTranscriptRecord,
  type TranscriptRecord,
} from "./session-transcript-record-parser.js";
import type { SessionTranscriptSourceSnapshot } from "./session-transcript-source-pages.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

vi.mock("./session-transcript-record-parser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-record-parser.js")>()),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes: string | Buffer) {
  const file = path.join(dirs.make("archive-index-"), "session.jsonl");
  await fs.promises.writeFile(file, bytes);
  return file;
}

function message(id: string | undefined, text: string) {
  return JSON.stringify({ type: "message", id, message: { role: "user", content: text } });
}

test("keeps exact physical ranges across newline dialects and malformed UTF8", async () => {
  const file = await fixture(
    Buffer.concat([
      Buffer.from(` \r\n${message("first", "α🦞".repeat(18000))}\r`),
      Buffer.from('{"type":"message","id":"invalid-utf8","message":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from(
        `"}}\n{malformed\r\n${message("", "blank raw id")}\n${message(undefined, "no id")}`,
      ),
    ]),
  );
  const records: TranscriptRecord[] = [];
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const parsed = parseTranscriptRecord(line);
    if (parsed) {
      records.push(parsed);
    }
  }
  const expected = selectArchiveTranscriptEntries(records).filter((entry) =>
    isVisibleTranscriptRecord(entry.record),
  );
  const index = await readSessionTranscriptIndex(file, "test");
  expect(index).not.toBeNull();
  const materialized = await readIndexedTranscriptEntries(file, index!, index!.entries, "test");
  expect(materialized.map(({ record, byteLength, id }) => ({ record, byteLength, id }))).toEqual(
    expected.map(({ record, byteLength, id }) => ({ record, byteLength, id })),
  );
  expect(index!.entries.map((entry) => entry.rawId)).toEqual([
    "first",
    "invalid-utf8",
    "",
    undefined,
  ]);
});

test("retains duplicate order, last by-ID selection and oversized image recovery", async () => {
  const image = JSON.stringify({
    type: "message",
    id: "image",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "caption" },
        { type: "image", mimeType: "image/png", data: Buffer.alloc(300000).toString("base64") },
      ],
    },
  });
  const file = await fixture(
    [message("same", "first"), image, message("same", "last")].join("\r\n"),
  );
  const index = (await readSessionTranscriptIndex(file, "test"))!;
  const records = await readIndexedTranscriptEntries(file, index, index.entries, "test");
  expect(records.map((entry) => entry.record.message)).toMatchObject([
    { content: "first" },
    { content: [{ text: "caption" }, { type: "image", omitted: true, bytes: 300000 }] },
    { content: "last" },
  ]);
  expect(records[1]?.recoveredImageData).toBe(true);
  expect(records[1]!.byteLength).toBeGreaterThan(256 * 1024);
  const last = await readIndexedTranscriptEntries(file, index, [index.byId.get("same")!], "test");
  expect(last[0]?.record.message).toMatchObject({ content: "last" });
  expect(index.entries.find((entry) => entry.id === "same")?.seq).toBe(1);
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
      JSON.stringify({ type: "custom_message", id: "early", message: activity }),
      message("anchor", "last anchor"),
      JSON.stringify({ type: "custom_message", id: "late", message: activity }),
    ].join("\r\n"),
  );
  const index = (await readSessionTranscriptIndex(file, "test"))!;
  const entries = await readIndexedTranscriptEntries(file, index, index.entries, "test");
  expect(entries).toHaveLength(4);
  expect(entries[1]?.record.message).toEqual(activity);
  expect(entries[1]?.transcriptPosition.activity).toBeUndefined();
  expect(entries[3]?.transcriptPosition.activity).toEqual({
    afterRawSeq: 3,
    scopeId: "scope",
    startOrder: 1,
  });
});

test("batches a page and rejects a rewrite while its pinned descriptor is being read", async () => {
  const file = await fixture(
    Array.from({ length: 40 }, (_, i) => message(String(i), "body")).join("\n"),
  );
  let index = (await readSessionTranscriptIndex(file, "test"))!;
  const actual = fileReads.readFileWindowFully;
  const reads = vi.spyOn(fileReads, "readFileWindowFully");
  await expect(
    readIndexedTranscriptEntries(file, index, index.entries, "test"),
  ).resolves.toHaveLength(40);
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockImplementationOnce(async (handle, buffer, position) => {
    const bytes = await actual(handle, buffer, position);
    await fs.promises.appendFile(file, "\n" + message("new", "rewritten"));
    return bytes;
  });
  await expect(
    readIndexedTranscriptEntries(file, index, index.entries, "test"),
  ).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
  index = (await readSessionTranscriptIndex(file, "test"))!;
  await expect(
    readIndexedTranscriptEntries(file, index, [index.entries.at(-1)!], "test"),
  ).resolves.toMatchObject([{ record: { id: "new" } }]);
});

const archiveSnapshot: SessionTranscriptSourceSnapshot = {
  indexedSeq: -1,
  activeEventCount: 0,
  totalMessages: 0,
  generation: undefined,
  tailEventSeq: undefined,
  resetSeq: null,
};

test("prepares cold source pages incrementally before selecting the final archive branch and reset", async () => {
  const rows = Array.from({ length: 260 }, (_, index) => ({
    type: "message",
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    message: { role: "user", content: `prompt ${index}` },
  }));
  const file = await fixture(
    [
      ...rows,
      { type: "leaf", id: "leaf", parentId: "message-259", targetId: "message-100" },
      { type: "reset", id: "reset", parentId: "message-100", firstKeptEntryId: "message-99" },
      {
        type: "message",
        id: "after-reset",
        parentId: "reset",
        message: { role: "assistant", content: "new reply" },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const reader = new ArchivedTranscriptReader({ sessionId: "test", exactArchivePath: file });
  const parse = vi.spyOn(recordParser, "parseTranscriptRecord");
  let page = await reader.readSourcePage({ mode: "page" }, archiveSnapshot);
  expect(page.messages).toEqual([]);
  expect(page.nextCursor).toMatchObject({ kind: "archive", position: 0, path: file });
  expect(parse.mock.calls.length).toBeLessThanOrEqual(128);
  const messages: unknown[] = [];
  let pulls = 0;
  while (page.nextCursor && pulls++ < 10) {
    parse.mockClear();
    page = await reader.readSourcePage({ mode: "page", cursor: page.nextCursor }, archiveSnapshot);
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
  const file = await fixture(
    JSON.stringify({
      type: "message",
      id: "large-image",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "caption" },
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.alloc(imageBytes).toString("base64"),
          },
        ],
      },
    }),
  );
  const reader = new ArchivedTranscriptReader({ sessionId: "test", exactArchivePath: file });
  const parse = vi.spyOn(recordParser, "parseTranscriptRecord");
  const reads = vi.spyOn(fileReads, "readFileWindowFully");
  await expect(reader.readSourcePage({ mode: "page" }, archiveSnapshot)).rejects.toThrow(
    "Transcript source message exceeds the 8388608-byte page limit",
  );
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
  await expect(reader.readSourcePage({ mode: "page" }, archiveSnapshot)).rejects.toThrow(
    "Transcript source message exceeds the 8388608-byte page limit",
  );
  await expect(reader.readById("large-image")).resolves.toMatchObject({ found: true });
  // The source-only rejection retains the completed index; only the selected payload is decoded.
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
    const pending = await withinTest(
      reader.readSourcePage({ mode: "page" }, archiveSnapshot),
      signal,
    );
    expect(pending.messages).toEqual([]);
    expect(pending.nextCursor).toMatchObject({ kind: "archive", position: 0 });
    release.resolve();
    await expect(ordinary).resolves.toMatchObject({ found: true, message: { content: "prompt" } });
    await expect(
      reader.readSourcePage({ mode: "page", cursor: pending.nextCursor }, archiveSnapshot),
    ).resolves.toMatchObject({ messages: [{ content: "prompt" }], nextCursor: undefined });
  } finally {
    release.resolve();
    await ordinary;
  }
});
