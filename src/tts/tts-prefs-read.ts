// Bounded reads for the operator-controlled TTS prefs document.
//
// `OPENCLAW_TTS_PREFS` and the configured `prefsPath` can point at any path, so a
// replaced or corrupted prefs file must not be able to pull an unbounded amount of
// bytes into memory. Both TTS prefs readers (settings and config resolution) share
// this owner instead of each calling `readFileSync` directly.
import { closeSync, openSync } from "node:fs";
import { readFileWindowFullySync } from "../infra/file-read.js";

// Far above any legitimate prefs document; anything larger is treated as unreadable.
export const TTS_PREFS_MAX_BYTES = 1024 * 1024;

/**
 * Read a TTS prefs file without letting an oversized file be slurped whole.
 *
 * Returns `undefined` when the file is larger than `maxBytes`; callers treat that
 * like an unreadable file and keep their defaults. Only the bounded window is
 * allocated and decoded, via the shared windowed-read owner.
 */
export function readBoundedTtsPrefsTextSync(
  prefsPath: string,
  maxBytes: number = TTS_PREFS_MAX_BYTES,
): string | undefined {
  const fd = openSync(prefsPath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readFileWindowFullySync(fd, buf, 0);
    // A full window means the file is at least maxBytes long; probe one byte past
    // it so a file of exactly maxBytes is still accepted.
    if (bytesRead === maxBytes) {
      const overflow = Buffer.alloc(1);
      const extra = readFileWindowFullySync(fd, overflow, maxBytes);
      if (extra > 0) {
        return undefined;
      }
    }
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
