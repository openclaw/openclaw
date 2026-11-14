import fs from "node:fs/promises";

// Optional cleanup should yield before second-long metadata commits compound.
const SLOW_COMMIT_MS = 1_000;

async function readKernelCounter(filePath: string): Promise<string> {
  try {
    const file = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    // Unsupported kernels, unmounted filesystems, and restricted proc/sys mounts
    // still get the caller's unconditional pacing.
    return "";
  }
}

/** One maintenance owner samples host counters; no background poller or retained filesystem list. */
export function createHostIoPressureProbe(): () => Promise<boolean> {
  let previous = new Map<string, { commits: number; totalMs: number }>();
  return async () => {
    if (process.platform !== "linux") {
      return false;
    }
    const started = performance.now();
    const psi = await readKernelCounter("/proc/pressure/io");
    // Co-tenant IO is normal. Brake only when at least half the last minute was
    // stalled, or our own IO round trip / filesystem commits take a full second.
    let pressured = Number(/^some avg10=[\d.]+ avg60=([\d.]+)/m.exec(psi)?.[1]) >= 50;
    const next = new Map<string, { commits: number; totalMs: number }>();
    const filesystems = await fs.readdir("/sys/fs/btrfs").catch(() => []);
    for (const id of filesystems) {
      if (!/^[\da-f-]{36}$/i.test(id)) {
        continue;
      }
      const stats = await readKernelCounter(`/sys/fs/btrfs/${id}/commit_stats`);
      const value = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(stats)?.[1]);
      const commits = value("commits");
      const totalMs = value("total_commit_ms");
      if (!Number.isFinite(commits) || !Number.isFinite(totalMs)) {
        continue;
      }
      const before = previous.get(id);
      const fresh = !before || commits !== before.commits || totalMs !== before.totalMs;
      // Lifetime max and unchanged last-commit values must never hold cleanup forever.
      pressured ||= value("cur_commit_ms") >= SLOW_COMMIT_MS;
      if (fresh) {
        pressured ||= value("last_commit_ms") >= SLOW_COMMIT_MS;
        if (before && commits > before.commits && totalMs >= before.totalMs) {
          pressured ||= (totalMs - before.totalMs) / (commits - before.commits) >= SLOW_COMMIT_MS;
        }
      }
      next.set(id, { commits, totalMs });
    }
    previous = next;
    return pressured || performance.now() - started >= SLOW_COMMIT_MS;
  };
}
