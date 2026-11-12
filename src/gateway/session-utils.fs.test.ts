import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { buildSessionPreviewItems } from "./session-display-projection.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
import {
  createArchiveSourceSnapshotFixture,
  createResetKeptTailTranscriptFixture,
} from "./session-transcript-archive.test-support.js";
import { collectSessionTranscriptMessages } from "./session-transcript-source-pages.js";
import {
  readLatestSessionUsageFromTranscriptFileAsync,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";

let tmpDir: string;
let id: string;
let nextId = 0;
beforeEach(() => {
  id = `transcript-${++nextId}`;
});
let storePath: string;
let imageData: string;
let imageBytes: number;
const requireRecord = createRequireRecord("object", "expected-label");
const textBlock = (text: string) => ({ type: "text", text });
const messageRow = (role: string, content: unknown, extra = {}) => ({ role, content, ...extra });
const assistant = (extra: Record<string, unknown>) => ({ role: "assistant", ...extra });
const artifact = (role: string, content: unknown) => ({ message: messageRow(role, content) });
const imageSource = (data: string, media_type = "image/png") => ({
  type: "base64",
  media_type,
  data,
});
const nativeImage = (data: string) => ({ type: "image", data });
const omittedImage = (bytes = imageBytes) => ({ type: "image", omitted: true, bytes });
const archiveTimestamp = "2026-08-28T00-00-00.000Z";
const signedText = (text: string, phase: string, signatureId?: string) => ({
  type: "text",
  text,
  textSignature: JSON.stringify({ v: 1, ...(signatureId ? { id: signatureId } : {}), phase }),
});

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
  records: unknown[],
  { stem = id, timestamp = archiveTimestamp, header = id } = {},
) {
  return writeRecords(path.join(tmpDir, `${stem}.jsonl.reset.${timestamp}`), [
    { type: "session", version: 3, id: header },
    ...records,
  ]);
}

function message(
  entryId: string,
  parentId: string | null | undefined,
  role: "user" | "assistant" | "toolResult",
  content: unknown,
  fields: Record<string, unknown> = {},
) {
  return {
    type: "message",
    id: entryId,
    ...(parentId === undefined ? {} : { parentId }),
    message: { role, content, ...fields },
  };
}

function reader(sessionFile?: string) {
  return new ArchivedTranscriptReader({ sessionId: id, storePath, sessionFile });
}

async function full(sessionFile?: string) {
  const archiveReader = reader(sessionFile);
  return collectSessionTranscriptMessages(
    (_scope, options) =>
      archiveReader.readSourcePage(options, createArchiveSourceSnapshotFixture()),
    { sessionId: id },
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
    archive([
      { type: "metadata", padding: "x".repeat(20 * 1024) },
      ...createResetKeptTailTranscriptFixture(),
    ]);
    const shortReads = installShortReads(16);
    const recent = await reader().readRecentWithStats({ maxMessages: 10, maxBytes: 16_384 });
    for (const rows of [await full(), recent.messages]) {
      expect(contents(rows)).toEqual([
        "kept question",
        "kept answer",
        [textBlock("Reset")],
        "new turn",
      ]);
    }
    expect(shortReads()).toBeGreaterThan(1);
  });

  test("keeps active-branch compaction markers reachable through pagination", async () => {
    archive([
      message("old-user", null, "user", "old prompt"),
      message("old-assistant", "old-user", "assistant", "old answer"),
      {
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
      },
      message("active-user", null, "user", "active prompt"),
      message("active-assistant", "active-user", "assistant", "active answer"),
      message("side-branch", "active-assistant", "assistant", "side branch"),
      { type: "leaf", id: "active-leaf", parentId: "side-branch", targetId: "active-assistant" },
    ]);
    const newest = await reader().readPage({ offset: 0, maxMessages: 2 });
    const oldest = await reader().readPage({ offset: 2, maxMessages: 1 });
    expect(newest.totalMessages).toBe(3);
    expect(contents(newest.messages)).toEqual(["active prompt", "active answer"]);
    expect(oldest.totalMessages).toBe(3);
    expect(contents(oldest.messages)).toEqual([[textBlock("Compaction")]]);
  });

  test("accepts stale generated session archives when the header matches the current session", async () => {
    id = "00000000-0000-4000-8000-000000000006";
    const stale = "00000000-0000-4000-8000-000000000007";
    archive([artifact("assistant", "valid stale-name archive")], { stem: stale });
    expect(contents(await full(`${stale}.jsonl`))).toEqual(["valid stale-name archive"]);
  });

  test("revalidates a custom archive header after same-path replacement", async () => {
    id = "00000000-0000-4000-8000-00000000000a";
    const file = archive([artifact("assistant", "matching archive")], {
      stem: "shared-topic-replaced",
    });
    const read = () => full("shared-topic-replaced.jsonl");
    expect(contents(await read())).toEqual(["matching archive"]);
    writeRecords(file, [
      { type: "session", version: 3, id: "00000000-0000-4000-8000-00000000000b" },
      artifact("assistant", "replaced archive"),
    ]);
    await expect(read()).resolves.toEqual([]);
    await expect(
      reader("shared-topic-replaced.jsonl").readRecentWithStats({ maxMessages: 1 }),
    ).resolves.toEqual({ messages: [], totalMessages: 0 });
  });

  test("uses the newest custom reset archive whose header matches the session", async () => {
    id = "00000000-0000-4000-8000-000000000008";
    const stem = "shared-topic-valid-latest";
    archive([artifact("assistant", "newer canonical archive")]);
    archive([artifact("assistant", "older valid archive")], {
      stem,
      timestamp: "2026-02-16T22-26-35.000Z",
    });
    archive([artifact("assistant", "newer invalid archive")], {
      stem,
      header: "00000000-0000-4000-8000-000000000009",
    });
    const calls = installShortReads(16);
    expect(contents(await full(`${stem}.jsonl`))).toEqual(["older valid archive"]);
    expect(calls()).toBeGreaterThan(1);
  });
});

describe("artifact usage", () => {
  function writeUsage(messages: unknown[]) {
    writeRecords(path.join(tmpDir, `${id}.jsonl`), [
      { type: "session", version: 1, id },
      ...messages.map((row) => ({ message: row })),
    ]);
  }
  const usage = () => readLatestSessionUsageFromTranscriptFileAsync(id, storePath);

  test("aggregates assistant usage asynchronously without readFileSync", async () => {
    writeUsage([
      assistant({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 1800, output: 400, cacheRead: 600, cost: { total: 0.0055 } },
      }),
      assistant({ usage: { input: 2400, output: 250, cacheRead: 900, cost: { total: 0.006 } } }),
      assistant({ provider: "openclaw", model: "command" }),
    ]);
    const readFile = vi.spyOn(fs, "readFileSync");
    const snapshot = await usage();
    expect(snapshot).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 4200,
      outputTokens: 650,
      cacheRead: 1500,
      totalTokens: 3550,
      totalTokensFresh: true,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0115, 8);
    expect(readFile).not.toHaveBeenCalled();
  });

  test.each(["command", "delivery-mirror", "gateway-injected", "automation-result"])(
    "retains a meaningful zero-cost artifact snapshot without a %s model identity",
    async (model) => {
      writeUsage([assistant({ provider: "openclaw", model, usage: { cost: { total: 0 } } })]);
      await expect(usage()).resolves.toEqual({ costUsd: 0 });
    },
  );

  test("treats unavailable JSONL context as terminal until a later valid snapshot", async () => {
    const cliUsage = (tokens: Record<string, unknown>, extra = {}) =>
      assistant({ provider: "claude-cli", model: "claude-opus-4-7", usage: tokens, ...extra });
    const old = cliUsage(
      { input: 128_814, output: 3000, cacheRead: 992_953, totalTokens: 1_124_767 },
      { api: "cli" },
    );
    const unavailable = cliUsage({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      contextUsage: { state: "unavailable" },
    });
    writeUsage([old]);
    const legacy = await usage();
    expect(legacy?.contextUsage).toEqual({ state: "unavailable" });
    expect(legacy?.totalTokens).toBeUndefined();
    writeUsage([old, unavailable]);
    const absent = await usage();
    expect(absent?.contextUsage).toEqual({ state: "unavailable" });
    expect(absent?.totalTokens).toBeUndefined();
    expect(absent?.totalTokensFresh).toBeUndefined();
    writeUsage([
      old,
      unavailable,
      cliUsage({ input: 67_932, output: 2000, cacheRead: 18_944, totalTokens: 88_876 }),
    ]);
    expect(await usage()).toMatchObject({ totalTokens: 88_876, totalTokensFresh: true });
  });

  test("estimates transcript context when local model telemetry is missing", async () => {
    const prompt = "local prompt ".repeat(200);
    const answer = "local response ".repeat(120);
    writeUsage([
      { role: "user", content: prompt },
      assistant({
        provider: "openai-completions",
        model: "local-llama",
        content: [{ type: "text", text: answer }],
      }),
    ]);
    expect(await usage()).toMatchObject({
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
  const prefix = textBlock("keep prefix text");
  const suffix = textBlock("keep suffix text");
  const document = {
    type: "document",
    source: imageSource(Buffer.from("%PDF-1.4\nexample").toString("base64"), "application/pdf"),
  };

  async function recent() {
    return (await reader().readRecentWithStats({ maxMessages: 10 })).messages;
  }
  function archiveUser(content: unknown, fields: Record<string, unknown> = {}) {
    return archive([message(id, null, "user", content, fields)]);
  }
  function rewrite(file: string, from: string, to: string) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(from, to));
  }

  async function expectOversized() {
    const rows = await recent();
    expect(rows).toMatchObject([
      {
        role: "user",
        content: [textBlock("[chat.history omitted: message too large]")],
        __openclaw: { id, truncated: true, reason: "oversized" },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(imageData);
    expect(await reader().readById(id)).toMatchObject({ found: true, oversized: true });
  }

  test.each([
    {
      name: "Anthropic source before type",
      image: (data: string) => ({
        source: imageSource(data),
        cache_control: { type: "ephemeral" },
        type: "image",
      }),
    },
    {
      name: "native and Anthropic payloads together",
      image: (data: string) => ({
        type: "image",
        data,
        source: imageSource(data),
      }),
    },
  ])("preserves recoverable reset-archive text around oversized $name", async ({ name, image }) => {
    archiveUser([document, prefix, image(imageData), suffix]);
    const expected = { role: "user", content: [document, prefix, omittedImage(), suffix] };
    const rows = projectChatDisplayMessages(await recent());
    expect(rows).toMatchObject([{ ...expected, __openclaw: { id } }]);
    expect(JSON.stringify(rows)).not.toContain(imageData);
    if (name === "Anthropic source before type") {
      expect(JSON.stringify(rows)).toContain('"cache_control":{"type":"ephemeral"}');
    }
    expect(await reader().readById(id)).toMatchObject({
      found: true,
      oversized: false,
      message: expected,
    });
  });

  test("omits every image even when its data is distant from its type", async () => {
    const privateImage = Buffer.from("private-image-payload");
    const privateData = privateImage.toString("base64");
    const metadata = { data: Buffer.from("notes").toString("base64") };
    archiveUser([
      prefix,
      { type: "image", metadata: { caption: "x".repeat(70 * 1024) }, data: privateData },
      { type: "image", metadata, data: imageData },
      suffix,
    ]);
    const single = await reader().readById(id);
    for (const row of [(await recent())[0], single.message]) {
      expect(row).toMatchObject({
        content: [
          prefix,
          omittedImage(privateImage.length),
          { type: "image", metadata, omitted: true, bytes: imageBytes },
          suffix,
        ],
      });
      expect(JSON.stringify(row)).not.toContain(privateData);
      expect(JSON.stringify(row)).not.toContain(imageData);
    }
    expect(single).toMatchObject({ found: true, oversized: false });
  });

  test("keeps oversized fallback when recovered JSON numbers expand after parsing", async () => {
    const file = archiveUser([prefix, nativeImage(imageData)], {
      compactNumbers: "__COMPACT_NUMBERS__",
    });
    const numbers = Array.from({ length: 13_000 }, () => "1e20").join(",");
    rewrite(file, '"__COMPACT_NUMBERS__"', `[${numbers}]`);
    await expectOversized();
  });

  test("rejects JSON-escaped transcript recovery marker collisions", async () => {
    const file = archiveUser([textBlock("__MARKER_SPOOF__"), nativeImage(imageData)]);
    rewrite(file, '"__MARKER_SPOOF__"', '"\\u005f_openclaw_omitted_image_0__"');
    await expectOversized();
  });

  test.each([
    [
      "unrelated oversized data",
      (data: string) => [{ type: "document", source: { type: "base64", data } }],
    ],
    ["malformed image base64", (data: string) => [nativeImage(`${data.slice(0, -1)}!`)]],
    [
      "oversized non-image residual",
      (data: string) => [nativeImage(data), textBlock("x".repeat(300 * 1024))],
    ],
    [
      "oversized unrelated data after a small image",
      (data: string) => [nativeImage("aGVsbG8="), { type: "document", data }],
    ],
    [
      "too many image candidates",
      (data: string) => [
        ...Array.from({ length: 33 }, () => nativeImage("aGVsbG8=")),
        nativeImage(data),
      ],
    ],
  ] as const)("keeps the existing oversized fallback for %s", async (_name, content) => {
    archiveUser(content(imageData));
    await expectOversized();
  });

  test("bounded recent reads do not expose a compact inactive side message", async () => {
    archive([
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
      (await reader().readRecentWithStats({ maxMessages: 10, maxBytes: 1024, maxLines: 10 }))
        .messages,
    ).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("readSessionMessagesAsync keeps id-less oversized message placeholders", async () => {
    const oversized = "w".repeat(300 * 1024);
    archive([artifact("assistant", oversized)]);
    const rows = await full();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain("[chat.history omitted: message too large]");
    expect(JSON.stringify(rows)).not.toContain(oversized);
  });
});

describe("buildSessionPreviewItems bounded projection", () => {
  test("parses only 12 visible signatures from the recovery 1024-row tail", () => {
    const visible = 704;
    const hidden = 320;
    const sourceMessages = Array.from({ length: visible + hidden }, (_, index) => ({
      role: index < visible ? "assistant" : "toolResult",
      content: [signedText(`message ${index}`, "final_answer", `preview-${index}`)],
    }));
    const sourceText = JSON.stringify(sourceMessages);
    const messages = sourceMessages;
    const signatureTexts = new Set(sourceMessages.map((row) => row.content[0]!.textSignature));
    const parse = vi.spyOn(JSON, "parse");
    const result = buildSessionPreviewItems(messages, 12, 120);
    const parsedSignatures = parse.mock.calls.filter(([value]) => signatureTexts.has(value)).length;
    parse.mockRestore();

    expect(result).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        role: "assistant",
        text: `message ${visible - 12 + index}`,
      })),
    );
    expect(JSON.stringify(messages)).toBe(sourceText);
    expect(parsedSignatures).toBe(12);
  });

  test("returns fewer previews when the input is exhausted", () => {
    expect(
      buildSessionPreviewItems(
        [
          null,
          {},
          messageRow("user", "first"),
          messageRow("toolResult", "hidden"),
          messageRow("assistant", "last"),
        ],
        12,
        120,
      ),
    ).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "last" },
    ]);
  });
});
