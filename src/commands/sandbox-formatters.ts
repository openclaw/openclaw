/**
 * Formatting utilities for sandbox CLI output
 */

export function formatStatus(running: boolean): string {
  return running ? "🟢 running" : "⚫ stopped";
}

export function formatSimpleStatus(running: boolean): string {
  return running ? "running" : "stopped";
}

export function formatImageMatch(matches: boolean): string {
  return matches ? "✓" : "⚠️  mismatch";
}
<<<<<<< HEAD
=======

export function countRunning(items: readonly { running: boolean }[]): number {
  return items.filter((item) => item.running).length;
}

export function countMismatches(items: readonly { imageMatch: boolean }[]): number {
  return items.filter((item) => !item.imageMatch).length;
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
