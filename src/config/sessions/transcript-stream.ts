import fs from "node:fs";
import readline from "node:readline";
import { ignoreMissingPath } from "../../infra/errno.js";
import { statIfExists } from "../../infra/path-existence.js";
import { readFileRangeAsync } from "./file-range.js";

const REVERSE_CHUNK_BYTES = 64 * 1024;

/**
 * Returns an empty async iterator if the file does not exist, is empty, or is
 * not a regular file.
 */
export async function* streamSessionTranscriptLines(filePath: string): AsyncGenerator<string> {
  const stat = await statIfExists(filePath);
  if (!stat || !stat.isFile() || stat.size <= 0) {
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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
 * Returns an empty async iterator if the file does not exist, is empty, or is
 * not a regular file. The implementation splits on newline bytes before UTF-8
 * decoding so multibyte characters survive arbitrary chunk boundaries.
 */
export async function* streamSessionTranscriptLinesReverse(
  filePath: string,
): AsyncGenerator<string> {
  const fileHandle = await fs.promises.open(filePath, "r").catch(ignoreMissingPath);
  if (!fileHandle) {
    return;
  }
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return;
    }

    let position = stat.size;
    let carry: Buffer = Buffer.alloc(0);
    while (position > 0) {
      const readLength = Math.min(position, REVERSE_CHUNK_BYTES);
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
        }
        lineEnd = index;
      }
      carry = combined.subarray(0, lineEnd);
    }

    const firstLine = carry.toString("utf-8").trim();
    if (firstLine) {
      yield firstLine;
    }
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}
