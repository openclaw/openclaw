// Streams one-property legacy JSON object stores without buffering the whole file.
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Root } from "@openclaw/fs-safe";

const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

type LegacyJsonStreamSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
};

class JsonCharacterCursor {
  private readonly chunks: AsyncIterator<string>;
  private chunk = "";
  private offset = 0;

  constructor(chunks: AsyncIterable<string>) {
    this.chunks = chunks[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    while (this.offset >= this.chunk.length) {
      const next = await this.chunks.next();
      if (next.done) {
        return false;
      }
      this.chunk = next.value;
      this.offset = 0;
    }
    return true;
  }

  async peek(): Promise<string | null> {
    return (await this.fill()) ? (this.chunk[this.offset] ?? null) : null;
  }

  async take(): Promise<string | null> {
    if (!(await this.fill())) {
      return null;
    }
    return this.chunk[this.offset++] ?? null;
  }

  async skipWhitespace(): Promise<void> {
    while (true) {
      const next = await this.peek();
      if (next === null || !JSON_WHITESPACE.has(next)) {
        return;
      }
      await this.take();
    }
  }
}

function parseLegacyJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // V8 parse errors can quote source bytes. Legacy state may contain device
    // credentials, so Doctor warnings must expose only a content-free message.
    throw new Error("legacy JSON store contains invalid JSON");
  }
}

async function expectCharacter(cursor: JsonCharacterCursor, expected: string): Promise<void> {
  await cursor.skipWhitespace();
  const actual = await cursor.take();
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)} in legacy JSON store`);
  }
}

/** The opening quote has already been consumed by the enclosing parser. */
async function readJsonStringToken(
  cursor: JsonCharacterCursor,
  enclosing: "string" | "object",
): Promise<string> {
  let raw = '"';
  let escaped = false;
  while (true) {
    const character = await cursor.take();
    if (character === null) {
      throw new Error(`unterminated ${enclosing} in legacy JSON store`);
    }
    raw += character;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      return raw;
    }
  }
}

async function readJsonString(cursor: JsonCharacterCursor): Promise<string> {
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== '"') {
    throw new Error("expected string in legacy JSON store");
  }
  const parsed = parseLegacyJson(await readJsonStringToken(cursor, "string"));
  if (typeof parsed !== "string") {
    throw new Error("invalid string in legacy JSON store");
  }
  return parsed;
}

async function readJsonObject(cursor: JsonCharacterCursor): Promise<unknown> {
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== "{") {
    throw new Error("legacy JSON entries must be objects");
  }
  let raw = "{";
  let depth = 1;
  while (depth > 0) {
    const character = await cursor.take();
    if (character === null) {
      throw new Error("unterminated object in legacy JSON store");
    }
    if (character === '"') {
      raw += await readJsonStringToken(cursor, "object");
      continue;
    }
    raw += character;
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    }
  }
  return parseLegacyJson(raw);
}

async function parseSinglePropertyObject(params: {
  chunks: AsyncIterable<string>;
  property: string;
  onEntry: (key: string, value: unknown) => void;
}): Promise<void> {
  const cursor = new JsonCharacterCursor(params.chunks);
  await expectCharacter(cursor, "{");
  const property = await readJsonString(cursor);
  if (property !== params.property) {
    throw new Error(`legacy JSON store must contain only ${params.property}`);
  }
  await expectCharacter(cursor, ":");
  await expectCharacter(cursor, "{");
  await cursor.skipWhitespace();
  if ((await cursor.peek()) !== "}") {
    while (true) {
      const key = await readJsonString(cursor);
      await expectCharacter(cursor, ":");
      params.onEntry(key, await readJsonObject(cursor));
      await cursor.skipWhitespace();
      const separator = await cursor.take();
      if (separator === "}") {
        break;
      }
      if (separator !== ",") {
        throw new Error("expected comma or object end in legacy JSON store");
      }
    }
  } else {
    await cursor.take();
  }
  await expectCharacter(cursor, "}");
  await cursor.skipWhitespace();
  if ((await cursor.take()) !== null) {
    throw new Error("legacy JSON store has trailing content");
  }
}

async function* decodeUtf8Chunks(
  handle: FileHandle,
  observeChunk: (chunk: Buffer | string) => Buffer,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const rawChunk of stream) {
    const text = decoder.decode(observeChunk(rawChunk), { stream: true });
    if (text) {
      yield text;
    }
  }
  const tail = decoder.decode();
  if (tail) {
    yield tail;
  }
}

function assertStableRead(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
  bytesRead: number,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size ||
    bytesRead !== after.size
  ) {
    throw new Error("legacy JSON store changed while it was being read");
  }
}

/** Hash a safely opened file, optionally parsing its single object property entry by entry. */
export async function readLegacyJsonObjectStream(params: {
  stateRoot: Root;
  relativePath: string;
  property?: string;
  onEntry?: (key: string, value: unknown) => void;
}): Promise<LegacyJsonStreamSnapshot> {
  await using opened = await params.stateRoot.open(params.relativePath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  const hash = createHash("sha256");
  let size = 0;
  try {
    const before = opened.stat;
    const observeChunk = (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      hash.update(chunk);
      size += chunk.byteLength;
      return chunk;
    };
    if (params.property && params.onEntry) {
      const chunks = decodeUtf8Chunks(opened.handle, observeChunk);
      await parseSinglePropertyObject({
        chunks,
        property: params.property,
        onEntry: params.onEntry,
      });
    } else {
      const stream = opened.handle.createReadStream({ autoClose: false, start: 0 });
      for await (const rawChunk of stream) {
        observeChunk(rawChunk);
      }
    }
    const after = await opened.handle.stat();
    assertStableRead(before, after, size);
    return {
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      sha256: hash.digest("hex"),
      size,
    };
  } catch (error) {
    if (error instanceof TypeError && /encoded data was not valid/i.test(error.message)) {
      throw new Error("legacy JSON store is not valid UTF-8", { cause: error });
    }
    throw error;
  }
}
