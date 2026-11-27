import fs from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createHostIoPressureProbe } from "../../infra/host-io-pressure.js";
import { isWorktreePermissionError } from "./removal-errors.js";

const directory = process.argv[2];
if (!directory) {
  throw new Error("Retired checkout path is required");
}

// 2026-11-20: one 392s removal stalled writers below the reservation watermark.
// Exit 75 yields the remaining tree to the serialized owner for another pass.
const deadline = process.platform === "linux" ? performance.now() + 30_000 : Infinity;
const hasIoPressure = createHostIoPressureProbe(directory, process.argv[3] === "resume");
let entries = 0;
let bytes = 0;
const MAX_ENTRIES = 128;
const MAX_BYTES = 8 * 1024 * 1024;

// Bound metadata bursts even before PSI or commit counters report distress.
// A single oversized file cannot be split: unlink it alone, then pause.
async function remove(target: string): Promise<boolean> {
  if (performance.now() >= deadline) {
    return false;
  }
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    return true;
  }
  if (stat.isDirectory()) {
    // Go module caches and pnpm stores leave read-only directories. Restore write access
    // only on directories this user owns, never on files (pnpm hardlinks them to its store).
    if ((stat.mode & 0o200) === 0 && stat.uid === process.getuid?.()) {
      // Pin the directory so a replaced leaf cannot chmod a symlink target.
      const fd = fs.openSync(
        target,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      try {
        fs.fchmodSync(fd, stat.mode | 0o200);
      } finally {
        fs.closeSync(fd);
      }
    }
    const handle = fs.opendirSync(target);
    try {
      let child;
      while ((child = handle.readSync())) {
        if (!(await remove(path.join(target, child.name)))) {
          return false;
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  const size = stat.isFile() ? stat.size : 0;
  if (entries && (entries >= MAX_ENTRIES || bytes + size > MAX_BYTES)) {
    await pause(100);
    if (await hasIoPressure()) {
      return false;
    }
    entries = 0;
    bytes = 0;
  }
  if (performance.now() >= deadline) {
    return false;
  }
  if (stat.isDirectory()) {
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  entries++;
  bytes += size;
  return true;
}

try {
  if ((await hasIoPressure()) || !(await remove(directory))) {
    process.exitCode = 75;
  }
} catch (error) {
  // Preserve the parent's existing permission-repair classification across exec.
  if (isWorktreePermissionError(error)) {
    throw new Error("Retired checkout permission denied", { cause: error });
  }
  throw error;
}
