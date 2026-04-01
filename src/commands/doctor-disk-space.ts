import fs from "node:fs";
import os from "node:os";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

// 100 MB — below this, config writes and session transcripts are likely to
// fail silently, causing data loss.
const CRITICAL_BYTES = 100 * 1024 * 1024;

// 500 MB — enough headroom for normal operation but worth a heads-up so
// operators can free space before it becomes critical.
const WARNING_BYTES = 500 * 1024 * 1024;

/**
 * Format a byte count into a human-readable string (B / KB / MB / GB).
 * Uses Math.floor for MB values to avoid rounding up past a decision
 * threshold (e.g. 99.6 MB should display as "99 MB", not "100 MB").
 * Exported for testing.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) {
    return "unknown";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.floor(bytes / (1024 * 1024))} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.floor(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Read available bytes on the partition that contains `dirPath`.
 * Returns `null` when the directory does not exist or `statfsSync` fails
 * (for example on a platform where it is unsupported).
 */
export function getAvailableBytes(
  dirPath: string,
  deps?: { statfsSync?: (p: string) => fs.StatsFs },
): number | null {
  const statfs = deps?.statfsSync ?? fs.statfsSync;
  try {
    const stats = statfs(dirPath);
    // `bavail` is the number of free blocks available to unprivileged users.
    // Multiply by `bsize` (optimal transfer / filesystem block size in Node's
    // StatsFs, equal to `f_bsize` from the underlying statfs syscall) to get
    // available bytes.
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * Build warning lines based on available disk space.
 * Pure function — exported for testing without FS side effects.
 */
export function buildDiskSpaceWarnings(params: {
  availableBytes: number;
  displayStateDir: string;
}): string[] {
  const { availableBytes, displayStateDir } = params;
  const displayFreeSpace = formatBytes(availableBytes);
  const warnings: string[] = [];

  if (availableBytes < CRITICAL_BYTES) {
    warnings.push(
      `- CRITICAL: only ${displayFreeSpace} free on the partition containing ${displayStateDir}.`,
    );
    warnings.push("- Config writes, session transcripts, and log rotation may fail silently.");
    warnings.push("- Free up disk space immediately to avoid data loss.");
  } else if (availableBytes < WARNING_BYTES) {
    warnings.push(
      `- Low disk space: ${displayFreeSpace} free on the partition containing ${displayStateDir}.`,
    );
    warnings.push("- Consider freeing space to prevent future config/session write failures.");
  }

  return warnings;
}

/**
 * Doctor health contribution: check free disk space on the partition that
 * holds the state directory and warn when it drops below safe thresholds.
 *
 * This catches a common operational failure mode where OpenClaw silently
 * fails to write config, sessions, or logs because the disk is full.
 */
export function noteDiskSpace(
  _cfg: OpenClawConfig, // reserved for API consistency with other Doctor contributions
  deps?: {
    env?: NodeJS.ProcessEnv;
    statfsSync?: (p: string) => fs.StatsFs;
  },
): void {
  const env = deps?.env ?? process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, homedir);

  const availableBytes = getAvailableBytes(stateDir, {
    statfsSync: deps?.statfsSync,
  });
  // If we cannot determine free space (directory missing, unsupported FS,
  // or permission error), skip silently — other contributions already
  // handle missing directories.
  if (availableBytes === null) {
    return;
  }

  const displayStateDir = shortenHomePath(stateDir);
  const warnings = buildDiskSpaceWarnings({ availableBytes, displayStateDir });

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Disk space");
  }
}
