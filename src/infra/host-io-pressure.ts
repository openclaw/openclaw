import fs from "node:fs/promises";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";

// Optional cleanup should yield before second-long metadata commits compound.
const SLOW_COMMIT_MS = 1_000;
// 2026-11-20: #202197's paced unlink still reached 100 GiB with fast commits.
const RESERVATION_HIGH = 40 * 1024 ** 3;
const RESERVATION_LOW = 20 * 1024 ** 3;

async function resolveBtrfsReservationCounter(root: string): Promise<string | undefined> {
  try {
    const directory = await fs.open(root, "r");
    let mountId: string | undefined;
    try {
      mountId = /^mnt_id:\s+(\d+)$/m.exec(
        await fs.readFile(`/proc/self/fdinfo/${directory.fd}`, "utf8"),
      )?.[1];
    } finally {
      await directory.close();
    }
    const fields = (await fs.readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .find((line) => mountId && line.startsWith(`${mountId} `))
      ?.split(" ");
    const boundary = fields?.indexOf("-") ?? -1;
    const source = fields?.[boundary + 2];
    if (boundary < 6 || fields?.[boundary + 1] !== "btrfs" || !source) {
      return undefined;
    }
    const stat = await fs.stat(decodeMountInfoPath(source), { bigint: true });
    // Btrfs subvolumes have synthetic st_dev values; match the backing device.
    const major = ((stat.rdev >> 8n) & 0xfffn) | ((stat.rdev >> 32n) & 0xfffff000n);
    const minor = (stat.rdev & 0xffn) | ((stat.rdev >> 12n) & 0xffffff00n);
    for (const id of await fs.readdir("/sys/fs/btrfs")) {
      if (!/^[\da-f-]{36}$/i.test(id)) {
        continue;
      }
      const base = `/sys/fs/btrfs/${id}`;
      for (const device of await fs.readdir(`${base}/devices`)) {
        if (
          (await readKernelCounter(`${base}/devices/${device}/dev`)).trim() === `${major}:${minor}`
        ) {
          return `${base}/allocation/metadata/bytes_may_use`;
        }
      }
    }
  } catch {
    // Unavailable mount/device metadata leaves ordinary pacing in place.
  }
  return undefined;
}

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
export function createHostIoPressureProbe(root?: string, resume = false): () => Promise<boolean> {
  let previous = new Map<string, { commits: number; totalMs: number }>();
  const reservationCounter =
    process.platform === "linux" && root ? resolveBtrfsReservationCounter(root) : undefined;
  let reservationPressure = resume;
  // 2026-11-20: a 6.34s commit stalled writers with only 39.6 G reserved.
  const slowCommitMs = root ? 500 : SLOW_COMMIT_MS;
  return async () => {
    if (process.platform !== "linux") {
      return false;
    }
    const started = performance.now();
    const psi = await readKernelCounter("/proc/pressure/io");
    // Co-tenant IO is normal. Brake only when at least half the last minute was
    // stalled, or our own IO round trip / filesystem commits take a full second.
    let pressured = Number(/^some avg10=[\d.]+ avg60=([\d.]+)/m.exec(psi)?.[1]) >= 50;
    const counter = await reservationCounter;
    if (counter) {
      const reserved = Number(await readKernelCounter(counter));
      reservationPressure = reserved >= (reservationPressure ? RESERVATION_LOW : RESERVATION_HIGH);
      pressured ||= reservationPressure;
    }
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
      pressured ||= value("cur_commit_ms") >= slowCommitMs;
      // A restarted removal pass has already cooled down; do not replay an old commit.
      if (fresh && (before || !root)) {
        pressured ||= value("last_commit_ms") >= slowCommitMs;
        if (before && commits > before.commits && totalMs >= before.totalMs) {
          // The interval total bounds its slowest commit; averaging hides a stall
          // followed by quick commits. The kernel maximum is lifetime, not recent.
          pressured ||= totalMs - before.totalMs >= slowCommitMs;
        }
      }
      next.set(id, { commits, totalMs });
    }
    previous = next;
    return pressured || performance.now() - started >= SLOW_COMMIT_MS;
  };
}
