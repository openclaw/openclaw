import fs from "node:fs";
import readline from "node:readline";

// Shared streaming helpers for JSONL session transcripts.
//
// Callers historically read the entire transcript with `fs.readFile` before
// splitting on newlines. That worked fine for short sessions but produced real
// memory pressure on long-running ones where transcripts grow to tens or
// hundreds of MB (see #54296). These helpers replace the whole-file reads with
// either a forward `readline` stream (bounded to one line of memory at a time)
// or a tail-only read that scans the last N bytes — both preserve the
// malformed-line tolerance and "first/last match wins" semantics callers rely
// on.

const DEFAULT_TAIL_BYTES = 4 * 1024 * 1024;
const ABSOLUTE_TAIL_CAP_BYTES = 64 * 1024 * 1024;
const MIN_TAIL_BYTES = 1024;

export type TranscriptStreamOptions = {
  signal?: AbortSignal;
};

export type TranscriptTailOptions = {
  /** Maximum bytes to read from the file tail. Clamped to [1KiB, 64MiB]. */
  maxBytes?: number;
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
  } catch {
    return;
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
 * Read the last `maxBytes` of a transcript file and return its non-empty
 * trimmed lines in reverse (newest-first) order. The first line of the slice
 * is discarded when the slice does not start at the file head, because it can
 * be the suffix of an earlier line split mid-way.
 *
 * Returns `undefined` if the file cannot be opened, `[]` if it exists but is
 * empty, and the trimmed reversed lines otherwise. Callers can return on the
 * first match without buffering the rest of the file.
 */
export async function readSessionTranscriptTailLines(
  filePath: string,
  options: TranscriptTailOptions = {},
): Promise<string[] | undefined> {
  const requestedMaxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(MIN_TAIL_BYTES, Math.floor(options.maxBytes as number))
    : DEFAULT_TAIL_BYTES;
  const cappedMaxBytes = Math.min(requestedMaxBytes, ABSOLUTE_TAIL_CAP_BYTES);

  let fileHandle: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    fileHandle = await fs.promises.open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile()) {
      return undefined;
    }
    if (stat.size <= 0) {
      return [];
    }
    const readLength = Math.min(stat.size, cappedMaxBytes);
    const readStart = Math.max(0, stat.size - readLength);
    const buffer = await readFileRangeAsync(fileHandle, readStart, readLength);
    const text = buffer.toString("utf-8");
    const rawLines = text.split(/\r?\n/);
    if (readStart > 0 && rawLines.length > 0) {
      rawLines.shift();
    }
    const lines: string[] = [];
    for (let index = rawLines.length - 1; index >= 0; index -= 1) {
      const trimmed = rawLines[index].trim();
      if (!trimmed) {
        continue;
      }
      lines.push(trimmed);
    }
    return lines;
  } catch {
    return undefined;
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

async function readFileRangeAsync(
  fileHandle: Awaited<ReturnType<typeof fs.promises.open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}
