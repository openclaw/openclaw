import fs from "node:fs";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createHostIoPressureProbe } from "../../infra/host-io-pressure.js";
import { isWorktreePermissionError } from "./removal-errors.js";

const directory = process.argv[2];
if (!directory) {
  throw new Error("Retired checkout path is required");
}

const hasIoPressure = createHostIoPressureProbe();
let entries = 0;
let bytes = 0;
const MAX_ENTRIES = 128;
const MAX_BYTES = 8 * 1024 * 1024;

// Bound metadata bursts even before PSI or commit counters report distress.
// A single oversized file cannot be split: unlink it alone, then pause.
async function remove(target: string): Promise<void> {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    return;
  }
  if (stat.isDirectory()) {
    const handle = fs.opendirSync(target);
    try {
      let child;
      while ((child = handle.readSync())) {
        await remove(path.join(target, child.name));
      }
    } finally {
      handle.closeSync();
    }
  }
  const size = stat.isFile() ? stat.size : 0;
  if (entries && (entries >= MAX_ENTRIES || bytes + size > MAX_BYTES)) {
    await pause(100);
    while (await hasIoPressure()) {
      await pause(5_000);
    }
    entries = 0;
    bytes = 0;
  }
  if (stat.isDirectory()) {
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
  entries++;
  bytes += size;
}

while (await hasIoPressure()) {
  await pause(5_000);
}
try {
  await remove(directory);
} catch (error) {
  // Preserve the parent's existing permission-repair classification across exec.
  if (isWorktreePermissionError(error)) {
    throw new Error("Retired checkout permission denied", { cause: error });
  }
  throw error;
}
