/**
 * Crash-loop detection and last-known-good config management.
 *
 * Tracks gateway startup timestamps and detects crash loops.
 * When a crash loop is detected, automatically reverts to the
 * last-known-good config.
 */

import fs from "node:fs";
import path from "node:path";

export type CrashTrackerState = {
  startupTimestamps: number[];
  lastRevertTimestamp?: number;
};

export type CrashTrackerOptions = {
  /** Max crashes within the window before triggering revert. Default: 3 */
  maxCrashes?: number;
  /** Time window in ms. Default: 60_000 (60s) */
  windowMs?: number;
  /** Seconds to wait before marking startup as healthy. Default: 10 */
  healthyAfterSeconds?: number;
};

const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_HEALTHY_AFTER_SECONDS = 10;
const CRASH_TRACKER_FILENAME = "crash-tracker.json";
const LAST_KNOWN_GOOD_SUFFIX = ".last-known-good";
const FAILED_CONFIG_PREFIX = ".failed-";

export function getCrashTrackerPath(stateDir: string): string {
  return path.join(stateDir, CRASH_TRACKER_FILENAME);
}

export function getLastKnownGoodPath(configPath: string): string {
  return configPath + LAST_KNOWN_GOOD_SUFFIX;
}

export function getFailedConfigPath(configPath: string, timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  return configPath + FAILED_CONFIG_PREFIX + ts;
}

export function readCrashTrackerState(stateDir: string): CrashTrackerState {
  const trackerPath = getCrashTrackerPath(stateDir);
  try {
    const raw = fs.readFileSync(trackerPath, "utf-8");
    const parsed = JSON.parse(raw) as CrashTrackerState;
    if (!Array.isArray(parsed.startupTimestamps)) {
      return { startupTimestamps: [] };
    }
    return parsed;
  } catch {
    return { startupTimestamps: [] };
  }
}

export function writeCrashTrackerState(stateDir: string, state: CrashTrackerState): void {
  const trackerPath = getCrashTrackerPath(stateDir);
  fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
  fs.writeFileSync(trackerPath, JSON.stringify(state, null, 2));
}

/**
 * Record a startup timestamp and check if we're in a crash loop.
 * Returns true if a crash loop is detected (caller should revert config).
 */
export function recordStartupAndCheckCrashLoop(
  stateDir: string,
  options: CrashTrackerOptions = {},
): boolean {
  const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();

  const state = readCrashTrackerState(stateDir);

  // Add current startup
  state.startupTimestamps.push(now);

  // Prune timestamps outside the window
  state.startupTimestamps = state.startupTimestamps.filter((ts) => now - ts <= windowMs);

  writeCrashTrackerState(stateDir, state);

  return state.startupTimestamps.length >= maxCrashes;
}

/**
 * Save the current config as last-known-good.
 * Should be called after gateway has been healthy for N seconds.
 */
export function saveLastKnownGood(configPath: string): boolean {
  const lkgPath = getLastKnownGoodPath(configPath);
  try {
    fs.copyFileSync(configPath, lkgPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a last-known-good config exists.
 */
export function hasLastKnownGood(configPath: string): boolean {
  return fs.existsSync(getLastKnownGoodPath(configPath));
}

/**
 * Revert to last-known-good config.
 * Saves the current (bad) config as a failed config for debugging.
 * Returns true if revert was successful.
 */
export function revertToLastKnownGood(configPath: string, stateDir: string): boolean {
  const lkgPath = getLastKnownGoodPath(configPath);
  if (!fs.existsSync(lkgPath)) {
    return false;
  }

  try {
    // Save current (bad) config for debugging
    const failedPath = getFailedConfigPath(configPath);
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, failedPath);
    }

    // Revert to last-known-good
    fs.copyFileSync(lkgPath, configPath);

    // Record the revert
    const state = readCrashTrackerState(stateDir);
    state.lastRevertTimestamp = Date.now();
    state.startupTimestamps = []; // Reset crash counter after revert
    writeCrashTrackerState(stateDir, state);

    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the crash tracker (call after healthy startup confirmed).
 */
export function clearCrashTracker(stateDir: string): void {
  const state = readCrashTrackerState(stateDir);
  state.startupTimestamps = [];
  writeCrashTrackerState(stateDir, state);
}

/**
 * Schedule saving last-known-good after healthy startup.
 * Returns a cancel function.
 */
export function scheduleLastKnownGoodSave(
  configPath: string,
  stateDir: string,
  options: CrashTrackerOptions = {},
): () => void {
  const healthyAfterSeconds = options.healthyAfterSeconds ?? DEFAULT_HEALTHY_AFTER_SECONDS;
  const timer = setTimeout(() => {
    saveLastKnownGood(configPath);
    clearCrashTracker(stateDir);
  }, healthyAfterSeconds * 1000);
  // Don't keep the process alive just for this timer
  timer.unref();
  return () => clearTimeout(timer);
}
