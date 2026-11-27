import fs from "node:fs";

/** Kernel-accounted storage reads for this thread, not logical reads or process totals. */
export function readThreadDiskReadBytes(): number | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const value = /^read_bytes:\s*(\d+)$/m.exec(
      fs.readFileSync("/proc/thread-self/io", "utf8"),
    )?.[1];
    const bytes = value === undefined ? Number.NaN : Number(value);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    // Missing procfs or denied accounting must not affect the operation.
    return undefined;
  }
}
