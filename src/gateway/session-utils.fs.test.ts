import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
import { collectSessionTranscriptMessages } from "./session-transcript-source-pages.js";
import {
  readLatestSessionUsageFromTranscriptFileAsync,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";

let tmpDir: string;
let storePath: string;
let imageData: string;
let imageBytes: number;
const requireRecord = createRequireRecord("object", "expected-label");
const archiveTimestamp = "2026-08-28T00-00-00.000Z";

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-fs-test-"));
  storePath = path.join(tmpDir, "sessions.json");
  const image = createNoisyPngBuffer(320, 320);
  imageData = image.toString("base64");
  imageBytes = image.length;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeRecords(file: string, records: unknown[]) {
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"));
  return file;
}

function archive(
  sessionId: string,
  records: unknown[],
  { stem = sessionId, timestamp = archiveTimestamp, header = sessionId } = {},
) {
  return writeRecords(path.join(tmpDir, `${stem}.jsonl.reset.${timestamp}`), [
    { type: "session", version: 3, id: header },
    ...records,
  ]);
}

function message(
  id: string,
  parentId: string | null | undefined,
  role: "user" | "assistant" | "toolResult",
  content: unknown,
  fields: Record<string, unknown> = {},
) {
  return {
    type: "message",
    id,
    ...(parentId === undefined ? {} : { parentId }),
    message: { role, content, ...fields },
  };
}

function reader(sessionId: string, sessionFile?: string) {
  return new ArchivedTranscriptReader({ sessionId, storePath, sessionFile });
}

async function full(sessionId: string, sessionFile?: string) {
  const archiveReader = reader(sessionId, sessionFile);
  return collectSessionTranscriptMessages(
    (_scope, options) =>
      archiveReader.readSourcePage(options, {
        indexedSeq: -1,
        activeEventCount: 0,
        totalMessages: 0,
        generation: undefined,
        tailEventSeq: undefined,
        resetSeq: null,
      }),
    { sessionId },
    { mode: "full", reason: "archive selection" },
  );
}

function contents(messages: unknown[]) {
  return messages.map((row) => requireRecord(row, "message").content);
}

function installShortReads(maxPerCall: number) {
  const realOpen = fs.promises.open.bind(fs.promises);
  let calls = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== "read") {
          return Reflect.get(target, property, receiver);
        }
        return (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const capped = position === null ? length : Math.min(length, maxPerCall);
          calls += Number(capped < length);
          return read(buffer, offset, capped, position);
        };
      },
    });
  });
  return () => calls;
}

describe("archive selection", () => {
  test("places the reset marker between retained and new turns", async () => {
    const id = "reset-kept-tail";
    archive(id, [
      message("old", null, "user", "old"),
      message("kept-user", "old", "user", "kept question"),
      message("kept-tool", "kept-user", "toolResult", "hidden tool"),
      message("kept-assistant", "kept-tool", "assistant", "kept answer"),
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        timestamp: "2026-07-22T00:00:00.000Z",
        reason: "new",
        firstKeptEntryId: "kept-user",
      },
      message("post-reset", "reset-boundary", "user", "new turn"),
    ]);
    const recent = await reader(id).readRecentWithStats({ maxMessages: 10, maxBytes: 16_384 });
    for (const rows of [await full(id), recent.messages]) {
      expect(contents(rows)).toEqual([
        "kept question",
        "kept answer",
        [{ type: "text", text: "Reset" }],
        "new turn",
      ]);
    }
  });

  test("keeps active-branch compaction markers reachable through pagination", async () => {
    const id = "paginated-compaction";
    archive(id, [
      message("old-user", null, "user", "old prompt"),
      message("old-assistant", "old-user", "assistant", "old answer"),
      {
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
        tokensBefore: 123,
      },
      message("active-user", null, "user", "active prompt"),
      message("active-assistant", "active-user", "assistant", "active answer"),
      message("side-branch", "active-assistant", "assistant", "side branch"),
      { type: "leaf", id: "active-leaf", parentId: "side-branch", targetId: "active-assistant" },
    ]);
    const newest = await reader(id).readPage({ offset: 0, maxMessages: 2 });
    const oldest = await reader(id).readPage({ offset: 2, maxMessages: 1 });
    expect(newest).toMatchObject({
      totalMessages: 3,
      messages: [
        { content: "active prompt", __openclaw: { seq: 2 } },
        { content: "active answer", __openclaw: { seq: 3 } },
      ],
    });
    expect(oldest).toMatchObject({
      totalMessages: 3,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          timestamp: Date.parse("2026-02-07T00:00:00.000Z"),
          __openclaw: { kind: "compaction", id: "comp-1", seq: 1, tokensBefore: 123 },
        },
      ],
    });
  });

  test("reads the latest reset archive independently of active artifacts", async () => {
    const id = "reset-archive-fallback";
    writeRecords(path.join(tmpDir, `${id}.jsonl`), [
      { type: "session", version: 1, id },
      { message: { role: "assistant", content: "active artifact" } },
    ]);
    archive(id, [{ message: { role: "assistant", content: "older archive" } }], {
      timestamp: "2026-02-16T22-26-33.000Z",
    });
    archive(id, [
      { message: { role: "user", content: "restored prompt" } },
      { message: { role: "assistant", content: "restored archive" } },
    ]);
    expect(contents(await full(id))).toEqual(["restored prompt", "restored archive"]);
    expect(await reader(id).readRecentWithStats({ maxMessages: 1, maxBytes: 2048 })).toMatchObject({
      transcriptSource: "reset-archive",
      totalMessages: 2,
      messages: [{ role: "assistant", content: "restored archive", __openclaw: { seq: 2 } }],
    });
  });

  test("accepts stale generated session archives when the header matches the current session", async () => {
    const id = "00000000-0000-4000-8000-000000000006";
    const stale = "00000000-0000-4000-8000-000000000007";
    archive(id, [{ message: { role: "assistant", content: "valid stale-name archive" } }], {
      stem: stale,
    });
    expect(contents(await full(id, `${stale}.jsonl`))).toEqual(["valid stale-name archive"]);
  });

  test("revalidates a custom archive header after same-path replacement", async () => {
    const id = "00000000-0000-4000-8000-00000000000a";
    const file = archive(id, [{ message: { role: "assistant", content: "matching archive" } }], {
      stem: "shared-topic-replaced",
    });
    const read = () => full(id, "shared-topic-replaced.jsonl");
    expect(contents(await read())).toEqual(["matching archive"]);
    writeRecords(file, [
      { type: "session", version: 3, id: "00000000-0000-4000-8000-00000000000b" },
      { message: { role: "assistant", content: "replaced archive" } },
    ]);
    await expect(read()).resolves.toEqual([]);
    await expect(
      reader(id, "shared-topic-replaced.jsonl").readRecentWithStats({ maxMessages: 1 }),
    ).resolves.toEqual({ messages: [], totalMessages: 0 });
  });

  test("uses the newest custom reset archive whose header matches the session", async () => {
    const id = "00000000-0000-4000-8000-000000000008";
    const stem = "shared-topic-valid-latest";
    archive(id, [{ message: { role: "assistant", content: "newer canonical archive" } }]);
    archive(id, [{ message: { role: "assistant", content: "older valid archive" } }], {
      stem,
      timestamp: "2026-02-16T22-26-35.000Z",
    });
    archive(id, [{ message: { role: "assistant", content: "newer invalid archive" } }], {
      stem,
      header: "00000000-0000-4000-8000-000000000009",
    });
    const calls = installShortReads(16);
    expect(contents(await full(id, `${stem}.jsonl`))).toEqual(["older valid archive"]);
    expect(calls()).toBeGreaterThan(1);
  });
});

describe("artifact usage", () => {
  function writeUsage(id: string, messages: unknown[]) {
    writeRecords(path.join(tmpDir, `${id}.jsonl`), [
      { type: "session", version: 1, id },
      ...messages.map((row) => ({ message: row })),
    ]);
  }
  const usage = (id: string) => readLatestSessionUsageFromTranscriptFileAsync(id, storePath);

  test("aggregates assistant usage asynchronously without readFileSync", async () => {
    const id = "usage-aggregate";
    writeUsage(id, [
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 1800, output: 400, cacheRead: 600, cost: { total: 0.0055 } },
      },
      {
        role: "assistant",
        usage: { input: 2400, output: 250, cacheRead: 900, cost: { total: 0.006 } },
      },
    ]);
    const readFile = vi.spyOn(fs, "readFileSync");
    const snapshot = await usage(id);
    expect(snapshot).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 4200,
      outputTokens: 650,
      cacheRead: 1500,
      totalTokens: 3300,
      totalTokensFresh: true,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0115, 8);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("retains a meaningful zero-cost artifact snapshot for a delivery mirror", async () => {
    const id = "usage-zero-cost";
    writeUsage(id, [
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: { cost: { total: 0 } },
      },
    ]);
    await expect(usage(id)).resolves.toEqual({ costUsd: 0 });
  });

  test("treats unavailable JSONL context as terminal until a later valid snapshot", async () => {
    const id = "usage-unavailable";
    const identity = { role: "assistant", provider: "claude-cli", model: "claude-opus-4-7" };
    const old = {
      ...identity,
      api: "cli",
      usage: { input: 128_814, output: 3000, cacheRead: 992_953, totalTokens: 1_124_767 },
    };
    const unavailable = {
      ...identity,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        contextUsage: { state: "unavailable" },
      },
    };
    writeUsage(id, [old]);
    const legacy = await usage(id);
    expect(legacy?.contextUsage).toEqual({ state: "unavailable" });
    expect(legacy?.totalTokens).toBeUndefined();
    writeUsage(id, [old, unavailable]);
    const absent = await usage(id);
    expect(absent?.contextUsage).toEqual({ state: "unavailable" });
    expect(absent?.totalTokens).toBeUndefined();
    expect(absent?.totalTokensFresh).toBeUndefined();
    writeUsage(id, [
      old,
      unavailable,
      {
        ...identity,
        usage: { input: 67_932, output: 2000, cacheRead: 18_944, totalTokens: 88_876 },
      },
    ]);
    expect(await usage(id)).toMatchObject({ totalTokens: 86_876, totalTokensFresh: true });
  });

  test("estimates transcript context when local model telemetry is missing", async () => {
    const id = "usage-estimate";
    const prompt = "local prompt ".repeat(200);
    const answer = "local response ".repeat(120);
    writeUsage(id, [
      { role: "user", content: prompt },
      {
        role: "assistant",
        provider: "openai-completions",
        model: "local-llama",
        content: [{ type: "text", text: answer }],
      },
    ]);
    expect(await usage(id)).toMatchObject({
      modelProvider: "openai-completions",
      model: "local-llama",
      totalTokens: estimateTokensFromChars(
        estimateStringChars(prompt) + estimateStringChars(answer),
      ),
      totalTokensFresh: true,
    });
  });
});

describe("transcript path safety", () => {
  test("drops unsafe session IDs instead of producing traversal paths", () => {
    expect(resolveSessionTranscriptCandidates("../etc/passwd", storePath)).toStrictEqual([]);
  });

  test("drops unsafe sessionFile candidates and keeps safe fallbacks", () => {
    const candidates = resolveSessionTranscriptCandidates("safe", storePath, "../../etc/passwd");
    expect(candidates.every((candidate) => !candidate.includes("etc/passwd"))).toBe(true);
    expect(candidates.map((candidate) => path.resolve(candidate))).toContain(
      path.join(tmpDir, "safe.jsonl"),
    );
  });
});

describe("oversized transcript records", () => {
  const prefix = { type: "text", text: "keep prefix text" };
  const suffix = { type: "text", text: "keep suffix text" };

  async function recent(id: string) {
    return (await reader(id).readRecentWithStats({ maxMessages: 10 })).messages;
  }

  async function expectOversized(id: string) {
    const rows = await recent(id);
    expect(rows).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
        __openclaw: { id, truncated: true, reason: "oversized" },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(imageData);
    expect(await reader(id).readById(id)).toMatchObject({ found: true, oversized: true });
  }

  test.each([
    {
      name: "Anthropic source before type",
      image: (data: string) => ({
        source: { type: "base64", media_type: "image/png", data },
        cache_control: { type: "ephemeral" },
        type: "image",
      }),
    },
    {
      name: "native and Anthropic payloads together",
      image: (data: string) => ({
        type: "image",
        data,
        source: { type: "base64", media_type: "image/png", data },
      }),
    },
  ])("preserves recoverable reset-archive text around oversized $name", async ({ name, image }) => {
    const id = `image-${name.replaceAll(" ", "-")}`;
    archive(id, [message(id, null, "user", [prefix, image(imageData), suffix])]);
    const expected = {
      role: "user",
      content: [prefix, { type: "image", omitted: true, bytes: imageBytes }, suffix],
    };
    const rows = projectChatDisplayMessages(await recent(id));
    expect(rows).toMatchObject([{ ...expected, __openclaw: { id } }]);
    expect(JSON.stringify(rows)).not.toContain(imageData);
    if (name === "Anthropic source before type") {
      expect(JSON.stringify(rows)).toContain('"cache_control":{"type":"ephemeral"}');
    }
    expect(await reader(id).readById(id)).toMatchObject({
      found: true,
      oversized: false,
      message: expected,
    });
  });

  test("omits every image even when its data is distant from its type", async () => {
    const id = "distant-image";
    const privateImage = Buffer.from("private-image-payload");
    const privateData = privateImage.toString("base64");
    const metadata = { data: Buffer.from("notes").toString("base64") };
    archive(id, [
      message(id, null, "user", [
        prefix,
        { type: "image", metadata: { caption: "x".repeat(70 * 1024) }, data: privateData },
        { type: "image", metadata, data: imageData },
        suffix,
      ]),
    ]);
    const single = await reader(id).readById(id);
    for (const row of [(await recent(id))[0], single.message]) {
      expect(row).toMatchObject({
        content: [
          prefix,
          { type: "image", omitted: true, bytes: privateImage.length },
          { type: "image", metadata, omitted: true, bytes: imageBytes },
          suffix,
        ],
      });
      expect(JSON.stringify(row)).not.toContain(privateData);
      expect(JSON.stringify(row)).not.toContain(imageData);
    }
    expect(single).toMatchObject({ found: true, oversized: false });
  });

  test("preserves a base64 PDF document preceding an oversized image", async () => {
    const id = "document-and-image";
    const document = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from("%PDF-1.4\nexample").toString("base64"),
      },
    };
    archive(id, [
      message(id, null, "user", [
        document,
        prefix,
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
        suffix,
      ]),
    ]);
    const rows = projectChatDisplayMessages(await recent(id));
    expect(rows).toMatchObject([
      {
        role: "user",
        content: [document, prefix, { type: "image", omitted: true, bytes: imageBytes }, suffix],
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(imageData);
  });

  test("keeps oversized fallback when recovered JSON numbers expand after parsing", async () => {
    const id = "expanded-json";
    const file = archive(id, [
      message(id, null, "user", [prefix, { type: "image", data: imageData }], {
        compactNumbers: "__COMPACT_NUMBERS__",
      }),
    ]);
    const numbers = Array.from({ length: 13_000 }, () => "1e20").join(",");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace('"__COMPACT_NUMBERS__"', `[${numbers}]`),
    );
    await expectOversized(id);
  });

  test("rejects JSON-escaped transcript recovery marker collisions", async () => {
    const id = "escaped-marker";
    const file = archive(id, [
      message(id, null, "user", [
        { type: "text", text: "__MARKER_SPOOF__" },
        { type: "image", data: imageData },
      ]),
    ]);
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace('"__MARKER_SPOOF__"', '"\\u005f_openclaw_omitted_image_0__"'),
    );
    await expectOversized(id);
  });

  test.each([
    {
      name: "unrelated oversized data",
      content: (data: string) => [{ type: "document", source: { type: "base64", data } }],
    },
    {
      name: "malformed image base64",
      content: (data: string) => [{ type: "image", data: `${data.slice(0, -1)}!` }],
    },
    {
      name: "oversized non-image residual",
      content: (data: string) => [
        { type: "image", data },
        { type: "text", text: "x".repeat(300 * 1024) },
      ],
    },
    {
      name: "oversized unrelated data after a small image",
      content: (data: string) => [
        { type: "image", data: "aGVsbG8=" },
        { type: "document", data },
      ],
    },
    {
      name: "too many image candidates",
      content: (data: string) => [
        ...Array.from({ length: 33 }, () => ({ type: "image", data: "aGVsbG8=" })),
        { type: "image", data },
      ],
    },
  ])("keeps the existing oversized fallback for $name", async ({ name, content }) => {
    const id = `adversarial-${name.replaceAll(" ", "-")}`;
    archive(id, [message(id, null, "user", content(imageData))]);
    await expectOversized(id);
  });

  test("bounded recent reads do not expose a compact inactive side message", async () => {
    const id = "leaf-outside-tail";
    archive(id, [
      message("active-root", null, "user", "active root"),
      {
        type: "metadata",
        id: "large-padding",
        parentId: "active-root",
        payload: { padding: "x".repeat(16 * 1024) },
      },
      message("side-delivery", "active-root", "assistant", "compact side delivery"),
      { type: "leaf", id: "active-leaf", parentId: "side-delivery", targetId: "active-root" },
    ]);
    const readFile = vi.spyOn(fs, "readFileSync");
    expect(
      (await reader(id).readRecentWithStats({ maxMessages: 10, maxBytes: 1024, maxLines: 10 }))
        .messages,
    ).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("oversized line metadata extraction preserves id and parentId", async () => {
    const id = "oversized-metadata";
    const timestamp = "2026-05-16T16:00:33.000Z";
    const oversized = "w".repeat(300 * 1024);
    archive(id, [
      message("root-msg", null, "user", "root"),
      {
        timestamp,
        ...message("oversized-child", "root-msg", "assistant", oversized, {
          idempotencyKey: "oversized-key",
        }),
      },
    ]);
    const rows = await recent(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
      __openclaw: {
        id: "oversized-child",
        idempotencyKey: "oversized-key",
        recordTimestampMs: Date.parse(timestamp),
      },
    });
    expect(JSON.stringify(rows)).not.toContain(oversized);
  });

  test("readSessionMessagesAsync keeps id-less oversized message placeholders", async () => {
    const id = "oversized-idless";
    const oversized = "w".repeat(300 * 1024);
    archive(id, [{ message: { role: "assistant", content: oversized } }]);
    const rows = await full(id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("[chat.history omitted: message too large]");
    expect(JSON.stringify(rows)).not.toContain(oversized);
  });
});

test("readRecentSessionMessagesAsync survives 16-byte tail read caps", async () => {
  const id = "short-read-recent";
  archive(
    id,
    Array.from({ length: 30 }, (_, index) => ({
      message: {
        role: index % 2 ? "assistant" : "user",
        content: `message ${index}: ${"data ".repeat(80)}`,
      },
    })),
  );
  const read = () => reader(id).readRecentWithStats({ maxMessages: 20, maxBytes: 8192 });
  const expected = await read();
  const calls = installShortReads(16);
  expect(await read()).toEqual(expected);
  expect(calls()).toBeGreaterThan(1);
});

describe("buildSessionPreviewItems bounded projection", () => {
  test("parses only 12 visible signatures from the recovery 1024-row tail", () => {
    const visible = 704;
    const hidden = 320;
    const sourceMessages = Array.from({ length: visible + hidden }, (_, index) => ({
      role: index < visible ? "assistant" : "toolResult",
      content: [
        {
          type: "text",
          text: `message ${index}`,
          textSignature: JSON.stringify({ v: 1, id: `preview-${index}`, phase: "final_answer" }),
        },
      ],
    }));
    const sourceText = JSON.stringify(sourceMessages);
    // SQLite hydration yields fresh blocks, so the per-block signature cache starts cold.
    const messages = JSON.parse(sourceText) as typeof sourceMessages;
    const originalRows = messages.slice();
    const originalContents = messages.map((row) => row.content);
    const signatureTexts = new Set(sourceMessages.map((row) => row.content[0]!.textSignature));
    const parse = JSON.parse;
    const descriptor = expectDefined(
      Object.getOwnPropertyDescriptor(JSON, "parse"),
      "native JSON.parse descriptor",
    );
    let parsedSignatures = 0;
    Object.defineProperty(JSON, "parse", {
      ...descriptor,
      value(...args: Parameters<typeof JSON.parse>) {
        if (signatureTexts.has(args[0])) {
          parsedSignatures += 1;
        }
        return parse(...args);
      },
    });
    let result: ReturnType<typeof buildSessionPreviewItems>;
    try {
      result = buildSessionPreviewItems(messages, 12, 120);
    } finally {
      Object.defineProperty(JSON, "parse", descriptor);
    }

    expect(result).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        role: "assistant",
        text: `message ${visible - 12 + index}`,
      })),
    );
    expect(JSON.stringify(messages)).toBe(sourceText);
    expect(messages.every((row, index) => row === originalRows[index])).toBe(true);
    expect(messages.every((row, index) => row.content === originalContents[index])).toBe(true);
    expect(parsedSignatures).toBe(12);
  });

  const visibilityMessages = [
    { role: "user", content: "older excluded text" },
    { role: "assistant", content: "NO_REPLY" },
    { role: "toolResult", content: "tool output" },
    { role: "user", content: [{ type: "input_text", text: "  question  " }] },
    { role: "assistant", content: "model only", display: false },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "private commentary",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
        },
        {
          type: "text",
          text: `${"x".repeat(16)}🦊tail`,
          textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
        },
      ],
    },
    { role: "assistant", content: "REPLY_SKIP" },
    { role: "assistant", content: [{ type: "text", text: "   " }] },
    { role: "system", content: "system metadata" },
  ];
  test.each([
    ...(
      [
        ["display", { role: "user", text: "question" }],
        ["model-context", { role: "assistant", text: "model only" }],
      ] as const
    ).map(([view, preceding]) => ({
      name: `${view} visibility, order and UTF-16 bounds`,
      messages: visibilityMessages,
      view,
      limit: 2,
      maxChars: 20,
      expected: [preceding, { role: "assistant", text: `${"x".repeat(16)}...` }],
    })),
    {
      name: "fewer visible items than the limit",
      messages: [
        null,
        undefined,
        {},
        { role: "user", content: "first" },
        { role: "toolResult", content: "tool output" },
        { role: "assistant", content: "ANNOUNCE_SKIP" },
        { role: "assistant", content: "hidden", display: false },
        { role: "assistant", content: "last" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "commentary only",
              textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
            },
          ],
        },
      ],
      view: undefined,
      limit: 12,
      maxChars: 120,
      expected: [
        { role: "user", text: "first" },
        { role: "assistant", text: "last" },
      ],
    },
  ])("preserves $name", ({ messages, expected, limit, maxChars, view }) => {
    const original = JSON.stringify(messages);
    expect(buildSessionPreviewItems(messages, limit, maxChars, view)).toEqual(expected);
    expect(JSON.stringify(messages)).toBe(original);
  });
});
