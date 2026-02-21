import fs from "node:fs";
import path from "node:path";

/**
 * Crash-loop protection for the gateway process.
 *
 * Tracks recent crash timestamps in a lightweight JSON file inside the state
 * directory and applies an escalating backoff schedule when the gateway keeps
 * crashing within a sliding window:
 *
 *   1-3  crashes  →  immediate restart  (current behaviour)
 *   4-6  crashes  →  30 s delay
 *   7-9  crashes  →  5 min delay
 *   10+  crashes  →  refuse to start, write crash report
 *
 * See issue #16810.
 */

const CRASH_HISTORY_FILENAME = "gateway-crash-history.json";
const CRASH_WINDOW_MS = 15 * 60 * 1000; // 15-minute sliding window
const BACKOFF_THRESHOLD = 3;
const MAX_CRASHES = 10;

const BACKOFF_TIERS: ReadonlyArray<{ minCrashes: number; delayMs: number }> = [
  { minCrashes: 7, delayMs: 5 * 60 * 1000 },
  { minCrashes: 4, delayMs: 30 * 1000 },
];

export interface CrashHistory {
  crashes: number[];
}

export interface CrashLoopGuardDeps {
  stateDir: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger: { warn: (msg: string) => void; error: (msg: string) => void };
}

function crashHistoryPath(stateDir: string): string {
  return path.join(stateDir, CRASH_HISTORY_FILENAME);
}

function readCrashHistory(filePath: string): CrashHistory {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CrashHistory;
    if (Array.isArray(parsed?.crashes)) {
      return { crashes: parsed.crashes.filter((t) => typeof t === "number") };
    }
  } catch {
    // missing or corrupt — start fresh
  }
  return { crashes: [] };
}

function writeCrashHistory(filePath: string, history: CrashHistory): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2), "utf-8");
  } catch {
    // best-effort — don't let crash tracking itself break startup
  }
}

function resolveBackoffMs(recentCount: number): number {
  for (const tier of BACKOFF_TIERS) {
    if (recentCount >= tier.minCrashes) {
      return tier.delayMs;
    }
  }
  return 0;
}

/**
 * Record a crash timestamp.  Safe to call from a synchronous
 * `process.on('exit')` handler because it uses only sync I/O.
 */
export function recordGatewayCrash(stateDir: string, now: number = Date.now()): void {
  const filePath = crashHistoryPath(stateDir);
  const history = readCrashHistory(filePath);
  history.crashes.push(now);
  const cutoff = now - CRASH_WINDOW_MS;
  history.crashes = history.crashes.filter((t) => t > cutoff);
  writeCrashHistory(filePath, history);
}

/**
 * Clear the crash history (called after a healthy startup period).
 */
export function clearGatewayCrashHistory(stateDir: string): void {
  const filePath = crashHistoryPath(stateDir);
  writeCrashHistory(filePath, { crashes: [] });
}

export class CrashLoopError extends Error {
  public readonly recentCrashCount: number;
  constructor(count: number, windowMinutes: number) {
    super(
      `CRASH LOOP DETECTED: ${count} crashes in the last ${windowMinutes} minutes. ` +
        `The gateway will not restart automatically. ` +
        `Fix the root cause, then run the gateway manually. ` +
        `To reset the crash counter immediately, delete the gateway-crash-history.json ` +
        `file in the state directory, or wait ${windowMinutes} minutes for it to expire.`,
    );
    this.name = "CrashLoopError";
    this.recentCrashCount = count;
  }
}

/**
 * Inspect crash history and apply backoff if needed.  Throws
 * `CrashLoopError` when the crash count exceeds the hard limit.
 */
export async function applyCrashLoopGuard(deps: CrashLoopGuardDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const filePath = crashHistoryPath(deps.stateDir);
  const history = readCrashHistory(filePath);
  const cutoff = now - CRASH_WINDOW_MS;
  const recentCrashes = history.crashes.filter((t) => t > cutoff);

  if (recentCrashes.length >= MAX_CRASHES) {
    const reportPath = path.join(deps.stateDir, "crash-report.json");
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            detectedAt: new Date(now).toISOString(),
            recentCrashCount: recentCrashes.length,
            windowMinutes: CRASH_WINDOW_MS / 60_000,
            crashTimestamps: recentCrashes.map((t) => new Date(t).toISOString()),
          },
          null,
          2,
        ),
        "utf-8",
      );
      deps.logger.error(`Crash report written to ${reportPath}`);
    } catch {
      // best-effort
    }
    throw new CrashLoopError(recentCrashes.length, CRASH_WINDOW_MS / 60_000);
  }

  if (recentCrashes.length >= BACKOFF_THRESHOLD) {
    const delayMs = resolveBackoffMs(recentCrashes.length);
    if (delayMs > 0) {
      deps.logger.warn(
        `Crash-loop backoff: ${recentCrashes.length} crashes in the last ${CRASH_WINDOW_MS / 60_000} min — ` +
          `waiting ${delayMs / 1000}s before starting gateway.`,
      );
      const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      await sleep(delayMs);
    }
  }
}

// Re-export constants for testing
export const _TEST_ONLY = {
  CRASH_WINDOW_MS,
  BACKOFF_THRESHOLD,
  MAX_CRASHES,
  BACKOFF_TIERS,
} as const;
