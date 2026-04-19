import fs from "node:fs/promises";

const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * Result from reading a log slice.
 */
export type TailReadResult = {
  /** New cursor position (byte offset) after reading */
  cursor: number;
  /** Current file size */
  size: number;
  /** Lines read from the file */
  lines: string[];
  /** Whether the read was truncated due to size limits */
  truncated: boolean;
  /** Whether a file rotation was detected (cursor > file size) */
  reset: boolean;
};

/**
 * Reads new lines from a file starting at a cursor position.
 * Handles file rotation by detecting when cursor exceeds file size.
 *
 * Based on the pattern from src/gateway/server-methods/logs.ts
 */
export async function readLogSlice(params: {
  file: string;
  cursor?: number;
  maxBytes?: number;
}): Promise<TailReadResult> {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;

  const stat = await fs.stat(params.file).catch(() => null);
  if (!stat) {
    return {
      cursor: 0,
      size: 0,
      lines: [],
      truncated: false,
      reset: false,
    };
  }

  const size = stat.size;
  let cursor =
    typeof params.cursor === "number" && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : undefined;
  let reset = false;
  let truncated = false;
  let start = 0;

  if (cursor != null) {
    if (cursor > size) {
      // File was rotated or truncated, start from beginning
      reset = true;
      start = 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        // Too much data to read, skip to recent data
        reset = true;
        truncated = true;
        start = Math.max(0, size - maxBytes);
      }
    }
  } else {
    // No cursor, read from end (up to maxBytes)
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  }

  if (size === 0 || size <= start) {
    return {
      cursor: size,
      size,
      lines: [],
      truncated,
      reset,
    };
  }

  const handle = await fs.open(params.file, "r");
  try {
    let prefix = "";
    if (start > 0) {
      // Check if we're starting mid-line
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }

    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");

    // If we started mid-line, drop the partial first line
    if (start > 0 && prefix !== "\n") {
      lines = lines.slice(1);
    }

    // Remove trailing empty line from split
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }

    return {
      cursor: size,
      size,
      lines,
      truncated,
      reset,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Reads lines that have been appended since the last read.
 * Returns only complete lines (excludes partial line at end if file is still being written).
 */
export async function readNewLines(params: {
  file: string;
  cursor: number;
  maxBytes?: number;
}): Promise<{
  lines: string[];
  newCursor: number;
  reset: boolean;
}> {
  const result = await readLogSlice({
    file: params.file,
    cursor: params.cursor,
    maxBytes: params.maxBytes,
  });

  return {
    lines: result.lines,
    newCursor: result.cursor,
    reset: result.reset,
  };
}
