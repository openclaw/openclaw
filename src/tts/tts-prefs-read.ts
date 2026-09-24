// Bounded reads for the operator-controlled TTS prefs document.
//
// `OPENCLAW_TTS_PREFS` and the configured `prefsPath` can point at any path, so a
// replaced or corrupted prefs file must not be able to pull an unbounded amount of
// bytes into memory. Both TTS prefs readers (settings and config resolution) share
// this owner instead of each calling `readFileSync` directly.
import { closeSync, openSync } from "node:fs";
import { readFileWindowFullySync } from "../infra/file-read.js";

// Far above any legitimate prefs document; anything larger is treated as unreadable.
const TTS_PREFS_MAX_BYTES = 1024 * 1024;

/**
 * Outcome of a bounded prefs read.
 *
 * `oversized` is distinct from a missing file on purpose: a read-only caller may
 * fall back to defaults, but the write path must not replace a file it refused to
 * read, or a setting update would silently erase the operator's existing prefs.
 */
export type TtsPrefsReadResult =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "oversized" };

/**
 * Read a TTS prefs file without letting an oversized file be slurped whole.
 *
 * Only the bounded window is ever allocated and decoded, via the shared
 * windowed-read owner. A file larger than `maxBytes` is reported as `oversized`
 * rather than parsed, so readers fall back to defaults *without* claiming the
 * file is empty.
 */
export function readBoundedTtsPrefsSync(
  prefsPath: string,
  maxBytes: number = TTS_PREFS_MAX_BYTES,
): TtsPrefsReadResult {
  let fd: number;
  try {
    fd = openSync(prefsPath, "r");
  } catch {
    return { status: "missing" };
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readFileWindowFullySync(fd, buf, 0);
    // A full window means the file is at least maxBytes long; probe one byte past
    // it so a file of exactly maxBytes is still accepted.
    if (bytesRead === maxBytes) {
      const overflow = Buffer.alloc(1);
      const extra = readFileWindowFullySync(fd, overflow, maxBytes);
      if (extra > 0) {
        return { status: "oversized" };
      }
    }
    return { status: "ok", text: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * Bounded read returning just the text, or `undefined` when the file is absent or
 * oversized. Read-only callers that keep defaults in both cases use this; the write
 * path uses {@link readBoundedTtsPrefsSync} so it can tell the two apart.
 */
export function readBoundedTtsPrefsTextSync(
  prefsPath: string,
  maxBytes: number = TTS_PREFS_MAX_BYTES,
): string | undefined {
  const result = readBoundedTtsPrefsSync(prefsPath, maxBytes);
  return result.status === "ok" ? result.text : undefined;
}
