import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

type ArchiveLineTransform = (line: string, owner: string) => { changed: boolean; content: string };

const ARCHIVE_STREAM_INPUT_CHUNK_SIZE = 1024 * 1024;

function* archiveInputChunks(bytes: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += ARCHIVE_STREAM_INPUT_CHUNK_SIZE) {
    yield bytes.subarray(offset, Math.min(offset + ARCHIVE_STREAM_INPUT_CHUNK_SIZE, bytes.length));
  }
}

type ArchiveTransformOptions = {
  bytes: Buffer;
  encoding: "identity" | "zstd";
  owner: string;
  signal?: AbortSignal;
  transformLine: ArchiveLineTransform;
};

async function* transformArchiveLineChunks(
  chunks: AsyncIterable<Buffer>,
  params: ArchiveTransformOptions,
): AsyncGenerator<{ bytes: Buffer; changed: boolean }> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 0;
  let nulSuffix = false;
  const emitLine = (line: string, terminated: boolean) => {
    lineNumber += 1;
    if (!line) {
      throw new Error(`${params.owner} contains a blank JSONL record at line ${lineNumber}`);
    }
    params.signal?.throwIfAborted();
    const transformed = params.transformLine(line, `${params.owner}:${lineNumber}`);
    return {
      bytes: Buffer.from(`${transformed.content}${terminated ? "\n" : ""}`, "utf8"),
      changed: transformed.changed,
    };
  };
  const acceptDecoded = (decoded: string): string => {
    if (nulSuffix) {
      if (/[^\0]/u.test(decoded)) {
        throw new Error(`${params.owner} contains non-NUL data after its terminal NUL suffix`);
      }
      return "";
    }
    const nul = decoded.indexOf("\0");
    if (nul === -1) {
      return decoded;
    }
    if (/[^\0]/u.test(decoded.slice(nul))) {
      throw new Error(`${params.owner} contains non-NUL data after its terminal NUL suffix`);
    }
    nulSuffix = true;
    return decoded.slice(0, nul);
  };

  for await (const chunk of chunks) {
    params.signal?.throwIfAborted();
    pending += acceptDecoded(decoder.write(Buffer.from(chunk)));
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      yield emitLine(pending.slice(0, newline), true);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  params.signal?.throwIfAborted();
  pending += acceptDecoded(decoder.end());
  if (pending) {
    yield emitLine(pending, false);
  }
  if (nulSuffix) {
    if (lineNumber === 0) {
      throw new Error(`${params.owner} contains no JSONL records before its terminal NUL suffix`);
    }
    yield { bytes: Buffer.alloc(0), changed: true };
  }
}

/**
 * Transforms JSONL one record at a time. Unchanged archives retain their original
 * bytes exactly; changed archives are decoded a second time and re-encoded with
 * the original codec, avoiding one archive-sized JavaScript string.
 */
export async function transformArchiveBytesIncrementally(
  params: ArchiveTransformOptions,
): Promise<{ changed: boolean; bytes: Buffer }> {
  const decoder = () => (params.encoding === "zstd" ? createZstdDecompress() : new PassThrough());
  let changed = false;
  // Await codec teardown as well as iteration errors before returning to Doctor.
  await pipeline(
    archiveInputChunks(params.bytes),
    decoder(),
    async (source: AsyncIterable<Buffer>) => {
      for await (const part of transformArchiveLineChunks(source, params)) {
        changed ||= part.changed;
      }
    },
  );
  if (!changed) {
    return { changed: false, bytes: params.bytes };
  }

  const chunks: Buffer[] = [];
  await pipeline(
    archiveInputChunks(params.bytes),
    decoder(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const part of transformArchiveLineChunks(source, params)) {
        yield part.bytes;
      }
    },
    params.encoding === "zstd" ? createZstdCompress() : new PassThrough(),
    async (encoded: AsyncIterable<Buffer>) => {
      for await (const chunk of encoded) {
        params.signal?.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
    },
  );
  params.signal?.throwIfAborted();
  return { changed: true, bytes: Buffer.concat(chunks) };
}
