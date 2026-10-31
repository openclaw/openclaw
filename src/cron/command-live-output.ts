/**
 * Bounded in-memory tail of a running cron command's combined stdout/stderr.
 *
 * `runCronCommandJob` is the only writer: it opens an entry before spawning and closes it in its
 * `finally`, so every end path (exit, timeout, abort, spawn error) discards the buffer. The
 * recorded run result stays the source of truth afterwards. Appending only copies bytes into a
 * fixed-size ring, so memory never exceeds the cap whatever the chunk sizes; sanitizing and
 * redaction run when a client reads, so unwatched jobs pay nothing. Only the bytes leaving the ring
 * are scanned, to remember whether a private key block is open at its first retained byte.
 */
import { stripAnsiSequences } from "../../packages/terminal-core/src/ansi.js";
import { replaceRedactPattern } from "../logging/redact-pattern-runtime.js";
import { createPemBlockTracker, type PemBlockTracker } from "../logging/redact-pem.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const COMMAND_LIVE_OUTPUT_MAX_BYTES = 256 * 1024;
/** A partial line longer than this is flushed so a prompt without a newline still shows up. */
const MAX_PENDING_LINE_BYTES = 4096;

type LiveOutputEntry = {
  runAtMs: number;
  /** Absolute byte offset `n` lives at `ring[n % ring.length]`. */
  ring: Buffer;
  /** Absolute byte offset after everything ever appended; cursors survive trimming. */
  end: number;
  /** Private key state at the first retained byte, fed by the bytes that left the ring. */
  head: PemBlockTracker;
};

export type CronCommandLiveOutputRead = {
  active: boolean;
  runAtMs?: number;
  cursor: number;
  text: string;
  /** The cursor was absent, stale, or from another run; `text` replaces what the caller holds. */
  reset?: true;
  /** Older output was dropped before the first returned byte. */
  truncated?: true;
};

const LIVE_OUTPUT_KEY = Symbol.for("openclaw.cron.commandLiveOutput");

function entries(): Map<string, LiveOutputEntry> {
  return resolveGlobalSingleton(LIVE_OUTPUT_KEY, () => new Map<string, LiveOutputEntry>());
}

/** Opens the live tail for one run. `append` never throws; `end` is idempotent. */
export function beginCronCommandLiveOutput(params: {
  jobId: string;
  runAtMs: number;
  outputMaxBytes?: number;
}) {
  const maxBytes = Math.max(
    1,
    Math.min(params.outputMaxBytes ?? COMMAND_LIVE_OUTPUT_MAX_BYTES, COMMAND_LIVE_OUTPUT_MAX_BYTES),
  );
  const entry: LiveOutputEntry = {
    runAtMs: params.runAtMs,
    ring: Buffer.alloc(maxBytes),
    end: 0,
    head: createPemBlockTracker(),
  };
  entries().set(params.jobId, entry);
  return {
    append(chunk: Buffer) {
      const { ring } = entry;
      trackEvicted(entry, chunk);
      // Only the last `ring.length` bytes can survive; they start at this absolute offset.
      const kept = chunk.subarray(Math.max(0, chunk.length - ring.length));
      const at = (entry.end + chunk.length - kept.length) % ring.length;
      const head = Math.min(kept.length, ring.length - at);
      kept.copy(ring, at, 0, head);
      kept.copy(ring, 0, head);
      entry.end += chunk.length;
    },
    end() {
      const registry = entries();
      if (registry.get(params.jobId) === entry) {
        registry.delete(params.jobId);
      }
    },
  };
}

/** Copies `length` retained bytes starting at absolute offset `from`. */
function sliceFrom(entry: LiveOutputEntry, from: number, length: number): Buffer {
  const { ring } = entry;
  const at = from % ring.length;
  const head = Math.min(length, ring.length - at);
  return Buffer.concat([ring.subarray(at, at + head), ring.subarray(0, length - head)]);
}

/** Feeds the bytes this chunk pushes out of the ring to the private key tracker, in order. */
function trackEvicted(entry: LiveOutputEntry, chunk: Buffer): void {
  const { ring, head } = entry;
  const oldStart = Math.max(0, entry.end - ring.length);
  const newStart = Math.max(0, entry.end + chunk.length - ring.length);
  const fromRing = Math.min(newStart, entry.end) - oldStart;
  if (fromRing > 0) {
    // Latin-1 strings keep one character per byte and never copy through a Buffer.
    const at = oldStart % ring.length;
    const first = Math.min(fromRing, ring.length - at);
    head.feed(ring.toString("latin1", at, at + first));
    head.feed(ring.toString("latin1", 0, fromRing - first));
  }
  head.feed(chunk.toString("latin1", 0, newStart - Math.min(newStart, entry.end)));
}

/** Index after the last line terminator; a trailing `\r` may still be half of `\r\n`. */
function endOfLastLine(data: Buffer): number {
  for (let i = data.length - 1; i >= 0; i -= 1) {
    if (data[i] === 0x0a || (data[i] === 0x0d && i < data.length - 1)) {
      return i + 1;
    }
  }
  return 0;
}

/** Drop a trailing incomplete UTF-8 sequence so a forced flush never splits a character. */
function endOfCompleteUtf8(data: Buffer): number {
  for (let back = 1; back <= Math.min(3, data.length); back += 1) {
    const byte = data[data.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) {
      continue;
    }
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? data.length - back : data.length;
  }
  return data.length;
}

/**
 * Strips terminal escapes and controls, then redacts with the tool-payload policy used for other
 * cron diagnostics. A private key spans many lines and reads, so `keys` (tracking everything
 * before `raw`) lets the PEM matcher mask a block whose opener was read earlier or has left the
 * ring.
 */
function presentLiveOutput(raw: string, keys: PemBlockTracker): string {
  const text = stripAnsiSequences(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Cc}/gu, (control) => (control === "\n" || control === "\t" ? control : ""));
  const masked = replaceRedactPattern(text, keys.pattern, (match) => match.replacement ?? "");
  // Masking a dangling block swallows the final newline; keep lines separate for the next read.
  return redactToolPayloadText(
    text.endsWith("\n") && !masked.endsWith("\n") ? `${masked}\n` : masked,
  );
}

/** Reads the active run's tail from `cursor`; inactive jobs report `active: false`. */
export function readCronCommandLiveOutput(
  jobId: string,
  request: { cursor?: number; runAtMs?: number } = {},
): CronCommandLiveOutputRead {
  const entry = entries().get(jobId);
  if (!entry) {
    return { active: false, cursor: 0, text: "" };
  }
  const start = Math.max(0, entry.end - entry.ring.length);
  const { cursor } = request;
  const continuing =
    cursor !== undefined &&
    request.runAtMs === entry.runAtMs &&
    cursor >= start &&
    cursor <= entry.end;
  const from = continuing ? cursor : start;
  const reset = !continuing;
  const base = {
    active: true as const,
    runAtMs: entry.runAtMs,
    ...(reset ? { reset: true as const } : {}),
    ...(reset && start > 0 ? { truncated: true as const } : {}),
  };
  if (from === entry.end) {
    return { ...base, cursor: from, text: "" };
  }
  const retained = sliceFrom(entry, start, entry.end - start);
  const before = from - start;
  let data = retained.subarray(before);
  let skipped = 0;
  if (from === start && start > 0) {
    // Head trimming can leave the first retained byte inside a multi-byte character.
    while (skipped < 3 && skipped < data.length && ((data[skipped] ?? 0) & 0xc0) === 0x80) {
      skipped += 1;
    }
    data = data.subarray(skipped);
  }
  const keys = entry.head.clone();
  keys.feed(retained.subarray(0, before).toString("latin1"));
  let cut = endOfLastLine(data);
  if (cut === 0 && data.length > MAX_PENDING_LINE_BYTES) {
    cut = endOfCompleteUtf8(data);
  }
  return {
    ...base,
    cursor: from + skipped + cut,
    text: presentLiveOutput(data.subarray(0, cut).toString("utf8"), keys),
  };
}
