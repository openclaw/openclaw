import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Direct preload affects only the supervisor; operation fixtures keep real clocks.
// The caller's source assertions pin the production safety durations being accelerated.
export function createProcessGroupTimingPreload(
  directory: string,
  { accelerateClock = true }: { accelerateClock?: boolean } = {},
) {
  const preloadPath = join(directory, "preload.cjs");
  writeFileSync(
    preloadPath,
    [
      ...(accelerateClock
        ? [
            "const realNow = Date.now.bind(Date);",
            "const startedAt = realNow();",
            "Date.now = () => startedAt + (realNow() - startedAt) * 100;",
          ]
        : []),
      // Signal escalation keeps real drain time after the accelerated TERM grace.
      "const realSetTimeout = globalThis.setTimeout;",
      "globalThis.setTimeout = (callback, delay, ...args) =>",
      "  realSetTimeout(callback, delay === 5000 ? 50 : delay, ...args);",
    ].join("\n"),
  );
  return preloadPath;
}
