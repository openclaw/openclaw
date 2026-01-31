/**
 * X channel state persistence.
 *
 * Tracks the last processed tweet ID to enable incremental polling.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { XPollState } from "./types.js";

/**
 * Get the state file path for an account.
 */
function getStateFilePath(dataDir: string, accountId: string): string {
  return path.join(dataDir, `x-${accountId}-state.json`);
}

/**
 * Load poll state from disk.
 */
export function loadXPollState(dataDir: string, accountId: string): XPollState {
  const filePath = getStateFilePath(dataDir, accountId);

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as XPollState;
    }
  } catch {
    // Ignore errors, return empty state
  }

  return {};
}

/**
 * Save poll state to disk.
 */
export function saveXPollState(dataDir: string, accountId: string, state: XPollState): void {
  const filePath = getStateFilePath(dataDir, accountId);

  try {
    // Ensure directory exists
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (error) {
    // Log but don't throw - state persistence is best-effort
    console.error("Failed to save X poll state:", error);
  }
}

/**
 * Update the last tweet ID in state.
 */
export function updateXLastTweetId(dataDir: string, accountId: string, tweetId: string): void {
  const state = loadXPollState(dataDir, accountId);
  state.lastTweetId = tweetId;
  state.lastPollAt = Date.now();
  saveXPollState(dataDir, accountId, state);
}
