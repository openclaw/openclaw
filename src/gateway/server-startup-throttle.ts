import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const STARTUP_THROTTLE_FILENAME = "gateway-startup-throttle.json";
// 30-minute window covers OOM-kill cycles where the gateway runs for several minutes before dying.
const RAPID_WINDOW_MS = 30 * 60_000;
const RAPID_THRESHOLD = 3;
// 10 minutes of clean post-sidecar uptime before declaring the start stable.
const STABLE_CLEAR_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;

type ThrottleRecord = { startedAt: number; rapidCount: number };

function throttleFilePath(stateDir: string): string {
  return path.join(stateDir, STARTUP_THROTTLE_FILENAME);
}

async function readThrottleRecord(stateDir: string): Promise<ThrottleRecord | null> {
  try {
    const raw = await fs.readFile(throttleFilePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).startedAt === "number" &&
      typeof (parsed as Record<string, unknown>).rapidCount === "number"
    ) {
      return parsed as ThrottleRecord;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeThrottleRecord(stateDir: string, record: ThrottleRecord): Promise<void> {
  try {
    await fs.writeFile(throttleFilePath(stateDir), JSON.stringify(record), "utf8");
  } catch {
    // best-effort; do not block startup on write errors
  }
}

export async function applyStartupRestartThrottle(params: {
  stateDir: string;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const now = Date.now();
  const prior = await readThrottleRecord(params.stateDir);
  const rapidCount =
    prior !== null && now - prior.startedAt < RAPID_WINDOW_MS ? prior.rapidCount + 1 : 1;

  await writeThrottleRecord(params.stateDir, { startedAt: now, rapidCount });

  if (rapidCount > RAPID_THRESHOLD) {
    const excess = rapidCount - RAPID_THRESHOLD;
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (excess - 1), BACKOFF_MAX_MS);
    params.log.warn(
      `gateway: rapid restart detected (${rapidCount} starts within ${RAPID_WINDOW_MS / 60_000}min); ` +
        `backing off ${backoffMs}ms before loading sidecars`,
    );
    await sleep(backoffMs);
  }
}

// Resets the rapid-restart counter after a stable uptime; call once sidecars succeed.
export function scheduleStartupThrottleClear(params: {
  stateDir: string;
  afterMs?: number;
}): () => void {
  const timer = setTimeout(() => {
    void writeThrottleRecord(params.stateDir, { startedAt: Date.now(), rapidCount: 0 });
  }, params.afterMs ?? STABLE_CLEAR_MS);
  timer.unref();
  return () => clearTimeout(timer);
}

export const __testing = {
  RAPID_WINDOW_MS,
  RAPID_THRESHOLD,
  STABLE_CLEAR_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  readThrottleRecord,
  writeThrottleRecord,
  throttleFilePath,
};
