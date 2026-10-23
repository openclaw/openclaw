import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { isMissingPathError } from "../infra/errno.js";
import { clamp } from "../utils.js";
import { isSameRollingLogFileFamily } from "./log-file-path.js";
import { getResolvedLoggerFileTarget } from "./logger.js";
import { parseLogLine, type ParsedLogLine } from "./parse-log-line.js";
import type { ResolvedRedactPattern } from "./redact-pattern-runtime.js";
import { redactSensitiveLines, resolveLogTailRedactOptions } from "./redact.js";

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 250_000;
const MAX_LIMIT = 5000;
const MAX_BYTES = 1_000_000;

type RedactionAnchor = {
  file: string;
  dev: number;
  ino: number;
  offset: number;
  states: ReadonlyMap<ResolvedRedactPattern, boolean>;
};

// Logs append and rotate by file. An in-place rewrite retaining this inode and
// size >= offset can reuse stale state; accepting that keeps polling window-sized.
let redactionAnchor: RedactionAnchor | undefined;

function invalidateRedactionAnchor(file: string, stat: Stats | null): void {
  if (
    redactionAnchor?.file === file &&
    (!stat ||
      stat.dev !== redactionAnchor.dev ||
      stat.ino !== redactionAnchor.ino ||
      stat.size < redactionAnchor.offset)
  ) {
    redactionAnchor = undefined;
  }
}

function missingPathToNull(error: unknown): null {
  if (!isMissingPathError(error)) {
    throw error;
  }
  return null;
}

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

type ResolvedLogFile = { file: string; stat: Stats | null };

/** Resolves a rolling daily log path to the newest existing rolling log when needed. */
async function resolveLogFile(file: string, rolling: boolean): Promise<ResolvedLogFile> {
  const stat = await fs.stat(file).catch(missingPathToNull);
  const source = { file, stat };
  if (stat || !rolling) {
    return source;
  }

  const dir = path.dirname(file);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(missingPathToNull);
  if (!entries) {
    return source;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSameRollingLogFileFamily(file, entry.name))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const fileStat = await fs.stat(fullPath).catch(missingPathToNull);
        return fileStat ? { file: fullPath, stat: fileStat } : null;
      }),
  );
  const sorted = candidates
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .toSorted((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return sorted[0] ?? source;
}

export async function readConfiguredLogTail(
  params?: { cursor?: number; limit?: number; maxBytes?: number },
  filter?: (line: string) => boolean,
): Promise<LogTailPayload> {
  const target = getResolvedLoggerFileTarget();
  const { file, stat } = await resolveLogFile(target.file, target.rolling);
  invalidateRedactionAnchor(file, stat);
  const requestedCursor = params?.cursor;
  const requestedLimit = params?.limit ?? DEFAULT_LIMIT;
  const requestedMaxBytes = params?.maxBytes ?? DEFAULT_MAX_BYTES;
  const redaction = resolveLogTailRedactOptions();
  if (stat && !stat.isFile()) {
    throw new Error(`Log path is not a regular file: ${file}`);
  }
  const size = stat?.size ?? 0;
  const maxBytes = clamp(requestedMaxBytes, 1, MAX_BYTES);
  const limit = clamp(requestedLimit, 1, MAX_LIMIT);
  let cursor =
    typeof requestedCursor === "number" && Number.isFinite(requestedCursor)
      ? Math.max(0, Math.floor(requestedCursor))
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
      file,
      cursor: size,
      size,
      lines: [],
      truncated,
      reset,
      skippedBytes,
    };
  }

  const handle = await fs.open(file, "r").catch(missingPathToNull);
  if (!handle) {
    // Rotation can remove the path after stat; retain the existing missing-file contract.
    return {
      file,
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
    let selected = lines.map((line) => filter?.(line) ?? true);
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

    const contexts = redaction.patterns.map((pattern) =>
      pattern instanceof RegExp ? undefined : pattern.createContext?.(),
    );
    let pending = contexts.filter((context) => context !== undefined);
    // Validate the opened inode too: rotation can replace the path after stat.
    const contextStat = pending.length > 0 ? await handle.stat() : undefined;
    if (contextStat) {
      invalidateRedactionAnchor(file, contextStat);
    }
    const contextStart = start + lineOffset;
    const cachedAnchor = redactionAnchor;
    const anchor =
      cachedAnchor?.file === file &&
      cachedAnchor.offset <= contextStart &&
      contexts.every(
        (context, index) => !context || cachedAnchor.states.has(redaction.patterns[index]!),
      )
        ? cachedAnchor
        : undefined;
    // Byte zero is the default anchor. A cold file may still require one full scan.
    const floor = anchor?.offset ?? 0;
    let contextEnd = contextStart;
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    cursor = start + lastNewline + 1;
    const completeWindow = lastNewline >= 0 && cursor >= contextStart;
    if (completeWindow && contextEnd > floor && pending.length > 0) {
      const prefixBuffer = Buffer.alloc(Math.min(contextEnd - floor, DEFAULT_MAX_BYTES));
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
      while (contextEnd > floor && pending.length > 0) {
        let search = Math.max(floor, contextEnd - blockBytes);
        let chunk = await readPrefix(search, contextEnd - search);
        let newline = chunk.indexOf(0x0a);
        let blockStart = search === floor ? floor : search + newline + 1;
        // Locate a whole-line boundary without retaining an arbitrarily long line.
        while (search > floor && (newline < 0 || blockStart === contextEnd)) {
          const end = search;
          blockBytes = Math.min(prefixBuffer.length, blockBytes * 2);
          search = Math.max(floor, end - blockBytes);
          chunk = await readPrefix(search, end - search);
          newline = chunk.lastIndexOf(0x0a);
          blockStart = search === floor && newline < 0 ? floor : search + newline + 1;
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

    if (completeWindow && contextStat) {
      const windowText = buffer.toString("utf8", lineOffset, cursor - start);
      const states = new Map<ResolvedRedactPattern, boolean>();
      for (const [index, context] of contexts.entries()) {
        if (context) {
          const pattern = redaction.patterns[index]!;
          context.resolve(anchor?.states.get(pattern) ?? false);
          states.set(pattern, context.advance(windowText));
        }
      }
      // Publish only complete records actually read: a partial line or concurrent
      // truncation must not move the next poll past bytes whose state is unknown.
      redactionAnchor = {
        file,
        dev: contextStat.dev,
        ino: contextStat.ino,
        offset: cursor,
        states,
      };
    }

    return {
      file,
      cursor,
      size,
      lines:
        selectedCount === 0
          ? []
          : redactSensitiveLines(
              lines,
              {
                ...redaction,
                patterns: redaction.patterns.map(
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

/** Reads the canonical configured tail and parses its already-redacted lines. */
export async function readConfiguredParsedLogTail(params?: {
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
