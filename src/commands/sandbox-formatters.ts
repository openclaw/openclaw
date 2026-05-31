/** Formats a rich status label for human sandbox tables. */
export function formatStatus(running: boolean): string {
  return running ? "🟢 running" : "⚫ stopped";
}

/** Formats a plain status label for JSON-adjacent or compact output. */
export function formatSimpleStatus(running: boolean): string {
  return running ? "running" : "stopped";
}

/** Marks whether a sandbox container image matches the expected runtime image. */
export function formatImageMatch(matches: boolean): string {
  return matches ? "✓" : "⚠️  mismatch";
}

/** Counts running sandbox runtimes from a list response. */
export function countRunning(items: readonly { running: boolean }[]): number {
  return items.filter((item) => item.running).length;
}

/** Counts sandbox runtimes whose container image differs from the expected image. */
export function countMismatches(items: readonly { imageMatch: boolean }[]): number {
  return items.filter((item) => !item.imageMatch).length;
}
