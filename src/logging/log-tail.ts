// Log tail helpers read recent log lines with optional parsing and redaction.
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isMissingPathError } from "../infra/errno.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { clamp } from "../utils.js";
import { isRollingLogFilePath, isSameRollingLogFileFamily } from "./log-file-path.js";
import "./logger.js";
import { getResolvedLoggerFileTarget } from "./logger-settings-internal.js";
import { parseLogLine, type ParsedLogLine } from "./parse-log-line.js";
import { redactSensitiveLines, resolveRedactOptions } from "./redact.js";

// Tail reader for the active log file, with cursor reset and line redaction.
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 250_000;
const MAX_LIMIT = 5000;
const MAX_BYTES = 1_000_000;

function missingPathToNull(error: unknown): null {
  if (!isMissingPathError(error)) {
    throw error;
  }
  return null;
}

/** Payload returned to log-tail callers with cursor and truncation metadata. */
export type LogTailPayload = {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
  skippedBytes?: number;
};

/** Redacted configured log tail with only parseable structured records. */
type ParsedLogTailPayload = Omit<LogTailPayload, "lines"> & {
  lines: ParsedLogLine[];
};

/** Resolves a rolling daily log path to the newest existing rolling log when needed. */
async function resolveLogFile(file: string, options?: { rolling?: boolean }): Promise<string> {
  const stat = await fs.stat(file).catch(missingPathToNull);
  if (stat) {
    return file;
  }
  if (!(options?.rolling ?? isRollingLogFilePath(file))) {
    return file;
  }

  const dir = path.dirname(file);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(missingPathToNull);
  if (!entries) {
    return file;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSameRollingLogFileFamily(file, entry.name))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const fileStat = await fs.stat(fullPath).catch(missingPathToNull);
        return fileStat ? { path: fullPath, mtimeMs: fileStat.mtimeMs } : null;
      }),
  );
  const sorted = candidates
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted[0]?.path ?? file;
}

async function readLogSlice(params: {
  file: string;
  cursor?: number;
  limit: number;
  maxBytes: number;
  filter?: (line: string) => boolean;
  redaction: ReturnType<typeof resolveRedactOptions>;
}): Promise<Omit<LogTailPayload, "file">> {
  const size = (await fs.stat(params.file).catch(missingPathToNull))?.size ?? 0;
  const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
  const limit = clamp(params.limit, 1, MAX_LIMIT);
  let cursor =
    typeof params.cursor === "number" && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : undefined;
  let reset = false;
  let skippedBytes: number | undefined;
  let truncated = false;
  let start;

  if (cursor != null) {
    if (cursor > size) {
      // File rotated or shrank since the previous cursor; restart near the end.
      reset = true;
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        // Keep reset as the re-anchor signal for existing clients. The skipped byte count
        // lets current clients distinguish this valid-cursor fast-forward from file shrink.
        reset = true;
        truncated = true;
        const boundedStart = Math.max(0, size - maxBytes);
        skippedBytes = boundedStart - start;
        start = boundedStart;
      }
    }
  } else {
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
      skippedBytes,
    };
  }

  const handle = await fs.open(params.file, "r").catch(missingPathToNull);
  if (!handle) {
    // Rotation can remove the path after stat; retain the existing missing-file contract.
    return {
      cursor: 0,
      size: 0,
      lines: [],
      truncated: false,
      reset: cursor != null && cursor > 0,
    };
  }
  try {
    let prefix = "";
    if (start > 0) {
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }

    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const bytesRead = await readFileWindowFully(handle, buffer, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    let lines = text.split("\n");
    lines.pop();
    let lineOffset = 0;
    if (start > 0 && prefix !== "\n") {
      // Drop the first partial line when starting in the middle of a file.
      lines.shift();
      lineOffset = buffer.subarray(0, bytesRead).indexOf(0x0a) + 1;
    }
    let selected = lines.map((line) => params.filter?.(line) ?? true);
    let selectedCount = selected.filter(Boolean).length;
    if (selectedCount > limit) {
      truncated = true;
      for (let index = 0; selectedCount > limit; index += 1) {
        if (selected[index]) {
          selected[index] = false;
          selectedCount -= 1;
        }
      }
    }
    const firstSelected = selected.indexOf(true);
    if (firstSelected > 0) {
      for (let index = 0; index < firstSelected; index += 1) {
        lineOffset = buffer.indexOf(0x0a, lineOffset) + 1;
      }
      lines = lines.slice(firstSelected);
      selected = selected.slice(firstSelected);
    }

    const contexts = params.redaction.patterns.map((pattern) =>
      pattern instanceof RegExp ? undefined : pattern.createContext?.(),
    );
    let pending = contexts.filter((context) => context !== undefined);
    let contextEnd = start + lineOffset;
    if (selectedCount > 0 && contextEnd > 0 && pending.length > 0) {
      const prefixBuffer = Buffer.alloc(Math.min(contextEnd, DEFAULT_MAX_BYTES));
      let blockBytes = Math.min(4096, prefixBuffer.length);
      let cached: { offset: number; length: number } | undefined;
      const readPrefix = async (offset: number, byteCount: number): Promise<Buffer> => {
        if (offset >= start && offset + byteCount <= start + bytesRead) {
          return buffer.subarray(offset - start, offset - start + byteCount);
        }
        if (
          cached &&
          offset >= cached.offset &&
          offset + byteCount <= cached.offset + cached.length
        ) {
          return prefixBuffer.subarray(offset - cached.offset, offset - cached.offset + byteCount);
        }
        const chunk = prefixBuffer.subarray(0, byteCount);
        if ((await readFileWindowFully(handle, chunk, offset)) !== byteCount) {
          throw new Error("Log file changed while reading redaction context");
        }
        cached = { offset, length: byteCount };
        return chunk;
      };
      while (contextEnd > 0 && pending.length > 0) {
        let search = Math.max(0, contextEnd - blockBytes);
        let chunk = await readPrefix(search, contextEnd - search);
        let newline = chunk.indexOf(0x0a);
        let blockStart = search === 0 ? 0 : search + newline + 1;
        // Locate a whole-line boundary without retaining an arbitrarily long line.
        while (search > 0 && (newline < 0 || blockStart === contextEnd)) {
          const end = search;
          blockBytes = Math.min(prefixBuffer.length, blockBytes * 2);
          search = Math.max(0, end - blockBytes);
          chunk = await readPrefix(search, end - search);
          newline = chunk.lastIndexOf(0x0a);
          blockStart = search === 0 && newline < 0 ? 0 : search + newline + 1;
        }
        const blocks = pending.map((context) => ({ context, block: context.prepend() }));
        const decoder = new StringDecoder("utf8");
        for (let offset = blockStart; offset < contextEnd;) {
          const byteCount = Math.min(prefixBuffer.length, contextEnd - offset);
          const prefixText = decoder.write(await readPrefix(offset, byteCount));
          for (const { block } of blocks) {
            block.consume(prefixText);
          }
          offset += byteCount;
        }
        const finalText = decoder.end();
        for (const { block } of blocks) {
          block.consume(finalText);
        }
        pending = blocks.filter(({ block }) => !block.finish()).map(({ context }) => context);
        contextEnd = blockStart;
        blockBytes = Math.min(prefixBuffer.length, blockBytes * 2);
      }
    }

    // Advance only through complete records actually read, not the earlier stat size:
    // concurrent truncation can shorten the read, and later appends must remain visible.
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    cursor = start + lastNewline + 1;

    return {
      cursor,
      size,
      lines:
        selectedCount === 0
          ? []
          : redactSensitiveLines(
              lines,
              {
                ...params.redaction,
                patterns: params.redaction.patterns.map(
                  (pattern, index) => contexts[index]?.pattern ?? pattern,
                ),
              },
              selected,
            ),
      truncated,
      reset,
      skippedBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Reads and redacts the configured log tail with bounded bytes and line count. */
export async function readConfiguredLogTail(
  params?: { cursor?: number; limit?: number; maxBytes?: number },
  filter?: (line: string) => boolean,
): Promise<LogTailPayload> {
  const target = getResolvedLoggerFileTarget();
  const file = await resolveLogFile(target.file, { rolling: target.rolling });
  const result = await readLogSlice({
    file,
    cursor: params?.cursor,
    limit: params?.limit ?? DEFAULT_LIMIT,
    maxBytes: params?.maxBytes ?? DEFAULT_MAX_BYTES,
    filter,
    redaction: resolveRedactOptions(),
  });
  return {
    file,
    ...result,
  };
}

/** Reads the canonical configured tail and parses its already-redacted lines. */
export async function readConfiguredParsedLogTail(params?: {
  cursor?: number;
  limit?: number;
  maxBytes?: number;
  filter?: (line: Pick<ParsedLogLine, "subsystem" | "module" | "plugin">) => boolean;
}): Promise<ParsedLogTailPayload> {
  const tail = await readConfiguredLogTail(params, (raw) => {
    const parsed = parseLogLine(raw);
    return parsed !== null && (params?.filter?.(parsed) ?? true);
  });
  return {
    ...tail,
    lines: tail.lines.flatMap((line) => {
      const parsed = parseLogLine(line);
      return parsed ? [parsed] : [];
    }),
  };
}
