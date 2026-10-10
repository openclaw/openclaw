import os from "node:os";
import { formatByteSize } from "@openclaw/normalization-core";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { shortenHomePath } from "../utils.js";

const DISK_SPACE_CHECK_ID = "core/doctor/disk-space";

// 100 MB — below this, config writes and session transcripts are likely to
// fail silently, causing data loss.
const CRITICAL_BYTES = 100 * 1024 * 1024;

// 500 MB — enough headroom for normal operation but worth a heads-up so
// operators can free space before it becomes critical.
const WARNING_BYTES = 500 * 1024 * 1024;

/** Floor MB/KB values so display rounding never crosses a warning threshold. */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) {
    return "unknown";
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "giga",
    separator: " ",
    fractionDigits: (_value, unit) => (unit === "byte" ? null : unit === "giga" ? 1 : 0),
    floorUnits: ["kilo", "mega"],
  });
}

function collectDiskSpaceWarnings() {
  const env = process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, homedir);

  const snapshot = tryReadDiskSpace(stateDir);
  // If we cannot determine free space (no existing ancestor, unsupported FS,
  // or permission error), skip silently — other contributions already
  // handle missing directories.
  if (!snapshot || !(snapshot.availableBytes < WARNING_BYTES)) {
    return null;
  }

  const displayStateDir = shortenHomePath(stateDir);
  const { availableBytes } = snapshot;
  const displayFreeSpace = formatBytes(availableBytes);
  const critical = availableBytes < CRITICAL_BYTES;
  return {
    critical,
    stateDir,
    displayFreeSpace,
    message: critical
      ? `CRITICAL: only ${displayFreeSpace} free on the partition containing ${displayStateDir}.`
      : `Low disk space: ${displayFreeSpace} free on the partition containing ${displayStateDir}.`,
    details: critical
      ? [
          "Config writes, session transcripts, and log rotation may fail silently.",
          "Free up disk space immediately to avoid data loss.",
        ]
      : ["Consider freeing space to prevent future config/session write failures."],
  };
}

/** Collects read-only structured findings for low disk space around the state directory. */
export function collectDiskSpaceHealthFindings(): readonly HealthFinding[] {
  const result = collectDiskSpaceWarnings();
  if (!result) {
    return [];
  }

  return [
    {
      checkId: DISK_SPACE_CHECK_ID,
      severity: result.critical ? "error" : "warning",
      message: result.message,
      path: result.stateDir,
      target: result.displayFreeSpace,
      requirement: result.critical ? "critical-free-space" : "low-free-space",
      fixHint: result.details.join(" "),
    },
  ];
}

export function noteDiskSpace(): void {
  const result = collectDiskSpaceWarnings();
  if (!result) {
    return;
  }

  note([result.message, ...result.details].map((line) => `- ${line}`).join("\n"), "Disk space");
}
