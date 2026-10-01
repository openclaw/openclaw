// Transcript streaming reads large JSONL files forward or backward without whole-file buffering.
import fs from "node:fs";
import readline from "node:readline";
import { hasErrnoCode } from "../../infra/errors.js";
import { readFileRangeAsync } from "./file-range.js";

const DEFAULT_REVERSE_CHUNK_BYTES = 64 * 1024;
const MAX_REVERSE_CHUNK_BYTES = 1024 * 1024;
const MIN_REVERSE_CHUNK_BYTES = 1024;

type TranscriptStreamOptions = {
  signal?: AbortSignal;
};

type TranscriptReverseStreamOptions = TranscriptStreamOptions & {
  /** Bytes read per reverse scan chunk. Clamped to [1KiB, 1MiB]. */
  chunkBytes?: number;
};

/**
 * Stream the non-empty, trimmed JSONL lines of a transcript file in order.
 *
 * Returns an empty async iterator if the file does not exist, is empty, or is
 * not a regular file. Honours `options.signal` between lines so long scans can
 * cooperate with abort signals.
 */
export async function* streamSessionTranscriptLines(
  filePath: string,
  options: TranscriptStreamOptions = {},
): AsyncGenerator<string> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return;
  }
  if (options.signal?.aborted) {
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (options.signal?.aborted) {
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      yield trimmed;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Stream the non-empty, trimmed JSONL lines of a transcript file in reverse
 * (newest-first) order.
 *
 * Returns an empty async iterator if the file does not exist, is empty, or is
 * not a regular file. The implementation splits on newline bytes before UTF-8
 * decoding so multibyte characters survive arbitrary chunk boundaries.
 */
export async function* streamSessionTranscriptLinesReverse(
  filePath: string,
  options: TranscriptReverseStreamOptions = {},
): AsyncGenerator<string> {
  const requestedChunkBytes = Number.isFinite(options.chunkBytes)
    ? Math.max(MIN_REVERSE_CHUNK_BYTES, Math.floor(options.chunkBytes as number))
    : DEFAULT_REVERSE_CHUNK_BYTES;
  const chunkBytes = Math.min(requestedChunkBytes, MAX_REVERSE_CHUNK_BYTES);

  let fileHandle: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    fileHandle = await fs.promises.open(filePath, "r");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.size <= 0 || options.signal?.aborted) {
      return;
    }

    let position = stat.size;
    let carry: Buffer = Buffer.alloc(0);
    while (position > 0) {
      if (options.signal?.aborted) {
        return;
      }
      const readLength = Math.min(position, chunkBytes);
      position -= readLength;
      const chunk = await readFileRangeAsync(fileHandle, position, readLength);
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = combined.length;
      // Split on newline bytes before decoding so UTF-8 characters crossing chunk boundaries stay
      // intact inside `carry`.
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) {
          continue;
        }
        const line = combined
          .subarray(index + 1, lineEnd)
          .toString("utf-8")
          .trim();
        if (line) {
          yield line;
          if (options.signal?.aborted) {
            return;
          }
        }
        lineEnd = index;
      }
      carry = combined.subarray(0, lineEnd);
    }

    const firstLine = carry.toString("utf-8").trim();
    if (firstLine && !options.signal?.aborted) {
      yield firstLine;
    }
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}
