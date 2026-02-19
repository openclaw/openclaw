import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type CronSnapshot = {
  ts: number;
  jobId: string;
  source: "realtime" | "snapshot";
  result: string;
  model?: string;
  durationMs?: number;
};

const MAX_SNAPSHOTS_PER_JOB = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function resolveSnapshotDir(storePath: string, jobId: string): string {
  const dir = path.dirname(path.resolve(storePath));
  return path.join(dir, "snapshots", jobId);
}

/**
 * Write a snapshot after a successful cron run.
 * Also prunes old snapshots (>7 days or >50 entries).
 */
export async function writeCronSnapshot(params: {
  storePath: string;
  snapshot: CronSnapshot;
}): Promise<void> {
  const dir = resolveSnapshotDir(params.storePath, params.snapshot.jobId);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${params.snapshot.ts}.json`;
  await fs.writeFile(path.join(dir, filename), JSON.stringify(params.snapshot) + "\n", "utf-8");
  await pruneSnapshots(dir);
}

/**
 * Find the best available snapshot for a failed job.
 * Priority: last 24h realtime → last 72h any → null.
 */
export async function findBestSnapshot(params: {
  storePath: string;
  jobId: string;
}): Promise<CronSnapshot | null> {
  const dir = resolveSnapshotDir(params.storePath, params.jobId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const now = Date.now();
  const h24 = 24 * 60 * 60 * 1000;
  const h72 = 72 * 60 * 60 * 1000;

  // Parse all snapshot files, sorted newest first.
  const snapshots: CronSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf-8");
      const snap = JSON.parse(raw.trim()) as CronSnapshot;
      if (typeof snap.ts === "number" && typeof snap.result === "string") {
        snapshots.push(snap);
      }
    } catch {
      // skip corrupt files
    }
  }
  snapshots.sort((a, b) => b.ts - a.ts);

  // Priority 1: last 24h, realtime, newest
  const recent24 = snapshots.find((s) => now - s.ts <= h24 && s.source === "realtime");
  if (recent24) return recent24;

  // Priority 2: last 72h, any source, newest
  const recent72 = snapshots.find((s) => now - s.ts <= h72);
  if (recent72) return recent72;

  return null;
}

/**
 * Format the snapshot prefix for outbound tagging.
 */
export function formatSnapshotPrefix(snapshot: CronSnapshot): string {
  const date = new Date(snapshot.ts);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `[Snapshot data from ${yyyy}-${mm}-${dd} ${hh}:${min}, not realtime]\n\n`;
}

/**
 * Compute a short hash of result text for dedup.
 */
export function hashResult(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

async function pruneSnapshots(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  const now = Date.now();

  // Remove files older than MAX_AGE_MS.
  const toRemove: string[] = [];
  for (const file of jsonFiles) {
    const tsStr = file.replace(".json", "");
    const ts = Number(tsStr);
    if (Number.isFinite(ts) && now - ts > MAX_AGE_MS) {
      toRemove.push(file);
    }
  }

  // If still over limit, remove oldest.
  const remaining = jsonFiles.filter((f) => !toRemove.includes(f));
  if (remaining.length > MAX_SNAPSHOTS_PER_JOB) {
    const excess = remaining.length - MAX_SNAPSHOTS_PER_JOB;
    for (let i = 0; i < excess; i++) {
      toRemove.push(remaining[i]!);
    }
  }

  for (const file of toRemove) {
    await fs.unlink(path.join(dir, file)).catch(() => {});
  }
}
