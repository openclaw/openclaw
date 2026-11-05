// Zstd compression for archived transcript artifacts (Codex-style cold tier).
// Archives are kept long-term by default, so compressing them is what keeps
// "never delete conversations" cheap: JSONL transcripts compress ~10:1.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline as pipelineStreams, Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import zlib from "node:zlib";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { openLocalFileSafely } from "../../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "./transcript-file-names.js";
export { SESSION_ARCHIVE_ZSTD_SUFFIX } from "./transcript-file-names.js";

const zstdCodec = resolveZstdCodec();

export function encodeSessionArchiveContent(content: string): {
  bytes: Buffer;
  suffix: "" | typeof SESSION_ARCHIVE_ZSTD_SUFFIX;
} {
  const plain = Buffer.from(content, "utf8");
  if (plain.length === 0) {
    return { bytes: plain, suffix: "" };
  }
  // Default zstd level (3) matches the ratio/speed point Codex uses for cold
  // rollouts; archives are write-once so speed matters less than footprint.
  return { bytes: zstdCodec.compress(plain), suffix: SESSION_ARCHIVE_ZSTD_SUFFIX };
}

// Only the publishing writer knows a trusted plaintext size; it verifies its own
// output in memory. Other readers decode incrementally through the stream reader.
export function readSessionArchiveContentSync(filePath: string, expectedBytes: number): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return zstdCodec.decompress(fs.readFileSync(filePath), expectedBytes).toString("utf8");
}

// Streaming bounds memory to one chunk regardless of expansion, so frame-declared
// sizes and compression ratios (p99 34x, max 114x in production) are never trusted.
// This ceiling bounds the work a corrupt or crafted frame can cause; valid
// archives are capped far lower by the writer's in-memory string.
const SESSION_ARCHIVE_MAX_DECODED_BYTES = 4 * 1024 * 1024 * 1024;

/** True when an archive's own bytes cannot be decoded; retrying the same file cannot succeed. */
export function isSessionArchiveDecodeError(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return (
    typeof code === "string" &&
    (code === "ERR_BUFFER_TOO_LARGE" || code === "Z_BUF_ERROR" || code.startsWith("ZSTD_error_"))
  );
}

function limitDecodedBytes(filePath: string): Transform {
  let decoded = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > SESSION_ARCHIVE_MAX_DECODED_BYTES) {
        const error = new RangeError(
          `Session archive ${filePath} expands past the ${SESSION_ARCHIVE_MAX_DECODED_BYTES}-byte read budget; the archive is unchanged. Move it out of the sessions directory to stop reading it, or decompress it elsewhere with zstd to inspect it.`,
        );
        callback(Object.assign(error, { code: "ERR_BUFFER_TOO_LARGE" }));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Decodes a compressed archive as a stream without a cache file; any read or
 * decode error is delivered through the returned stream.
 */
export function openSessionArchiveDecodedStream(filePath: string): Readable {
  return pipelineStreams(
    fs.createReadStream(filePath),
    zlib.createZstdDecompress(),
    limitDecodedBytes(filePath),
    () => undefined,
  );
}

/** Every reader identity of one compressed archive path starts with this prefix. */
export function resolveSessionArchiveReadPathPrefix(filePath: string, cacheDir?: string): string {
  const pathKey = createHash("sha256").update(filePath).digest("hex").slice(0, 32);
  return path.join(
    cacheDir ?? path.join(resolvePreferredOpenClawTmpDir(), "session-archive-read-cache"),
    `${pathKey}-`,
  );
}

/** Resolve the reader identity from source metadata without expanding archive bytes. */
export function resolveSessionArchiveReadPath(
  filePath: string,
  sourceStat: Pick<fs.Stats, "size" | "mtimeMs">,
  cacheDir?: string,
): string {
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    return filePath;
  }
  return `${resolveSessionArchiveReadPathPrefix(filePath, cacheDir)}${sourceStat.size}-${Math.trunc(sourceStat.mtimeMs)}.jsonl`;
}

/** Positional decoded reads retain one stream chunk and never create a plaintext file. */
export async function openSessionArchiveReader(filePath: string) {
  const handle = await fs.promises.open(filePath, "r");
  let stream: Readable | undefined;
  let chunks: AsyncIterator<unknown> | undefined;
  let pending: Buffer = Buffer.alloc(0);
  let offset = 0;
  const stop = async () => {
    const previous = stream;
    stream = undefined;
    chunks = undefined;
    pending = Buffer.alloc(0);
    previous?.destroy();
    if (previous) {
      await finished(previous, { cleanup: true }).catch(() => undefined);
    }
  };
  // A destroyed FileHandle read stream closes its descriptor, even with autoClose:false.
  // Decoder restarts own only this iterator; close() alone owns the source descriptor.
  async function* readSource() {
    let position = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        return;
      }
      position += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  }
  return {
    stat: () => handle.stat(),
    async read(buffer: Buffer, position: number): Promise<number> {
      if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
        return readFileWindowFully(handle, buffer, position);
      }
      if (position < offset) {
        await stop();
      }
      if (!chunks) {
        offset = 0;
        stream = pipelineStreams(
          Readable.from(readSource(), { objectMode: false }),
          zlib.createZstdDecompress(),
          limitDecodedBytes(filePath),
          () => undefined,
        );
        chunks = stream[Symbol.asyncIterator]();
      }
      let copied = 0;
      while (copied < buffer.length) {
        if (pending.length === 0) {
          const next = await chunks.next();
          if (next.done) {
            break;
          }
          if (!Buffer.isBuffer(next.value)) {
            throw new TypeError("Expected decoded archive bytes");
          }
          pending = next.value;
        }
        const skip = Math.min(Math.max(0, position - offset), pending.length);
        offset += skip;
        pending = pending.subarray(skip);
        if (pending.length > 0) {
          const length = pending.copy(buffer, copied, 0, buffer.length - copied);
          pending = pending.subarray(length);
          offset += length;
          copied += length;
        }
      }
      return copied;
    },
    async close() {
      await stop();
      await handle.close();
    },
  };
}

export async function readSessionArchivePrefix(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  if (!filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    await using opened = await openLocalFileSafely({ filePath });
    return buffer.subarray(0, await readFileWindowFully(opened.handle, buffer, 0));
  }
  const reader = await openSessionArchiveReader(filePath);
  try {
    return buffer.subarray(0, await reader.read(buffer, 0));
  } finally {
    await reader.close();
  }
}

export async function readSessionArchiveText(filePath: string): Promise<string> {
  const reader = await openSessionArchiveReader(filePath);
  try {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const parts: string[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const length = await reader.read(buffer, offset);
      if (length === 0) {
        break;
      }
      parts.push(decoder.decode(buffer.subarray(0, length), { stream: true }));
      offset += length;
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    await reader.close();
  }
}
