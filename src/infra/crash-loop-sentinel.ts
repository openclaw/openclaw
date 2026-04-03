import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveStateDir } from "../config/paths.js";

const CRASH_LOOP_SENTINEL_FILENAME = "crash-loop-sentinel.json";
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;
const EX_CONFIG = 78;

export type CrashLoopSentinelData = {
  version: 1;
  startupTimestamps: number[];
};

export function resolveCrashLoopSentinelPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), CRASH_LOOP_SENTINEL_FILENAME);
}

export async function readCrashLoopSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CrashLoopSentinelData> {
  const filePath = resolveCrashLoopSentinelPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CrashLoopSentinelData | undefined;
    if (parsed?.version === 1 && Array.isArray(parsed.startupTimestamps)) {
      return parsed;
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return { version: 1, startupTimestamps: [] };
}

export async function writeCrashLoopSentinel(
  data: CrashLoopSentinelData,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveCrashLoopSentinelPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Checks whether the gateway is in a crash loop and aborts if so.
 *
 * Tracks startup timestamps in a sentinel file. If 3 or more starts occur
 * within 60 seconds, exits with code 78 (EX_CONFIG) after printing a
 * diagnostic message.
 *
 * This prevents infinite restart loops caused by config errors.
 */
export async function checkCrashLoopAndAbort(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const now = Date.now();
  const data = await readCrashLoopSentinel(env);

  // Append current startup timestamp and trim entries older than 60s
  const recentTimestamps = [...data.startupTimestamps, now].filter(
    (ts) => now - ts < CRASH_LOOP_WINDOW_MS,
  );

  const count = recentTimestamps.length;

  if (count >= CRASH_LOOP_THRESHOLD) {
    process.stderr.write(
      `\n⛔ Gateway crash loop detected: ${count} restarts in the last 60s.\n` +
        `   This usually means openclaw.json has a config error.\n` +
        `   Run: openclaw doctor\n` +
        `   Or check: ~/.openclaw/openclaw.json\n` +
        `   Stopping auto-restart to prevent resource exhaustion.\n`,
    );
    process.exit(EX_CONFIG);
    return;
  }

  // Save updated history
  await writeCrashLoopSentinel({ version: 1, startupTimestamps: recentTimestamps }, env);
}
