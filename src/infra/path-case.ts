// Shares path-local case observations and keeps OpenClaw's fallback policy.
import type { Stats } from "node:fs";
import { probePathCaseInsensitiveSync } from "@openclaw/fs-safe/advanced";

export { probePathCaseInsensitiveSync as tryResolvePathCaseInsensitive } from "@openclaw/fs-safe/advanced";

export function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

// Case probes compare dev and ino exactly; zero values are never wildcards.
export function sameFsObject(
  a: Pick<Stats, "dev" | "ino">,
  b: Pick<Stats, "dev" | "ino">,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Returns whether the target path's filesystem matches names case-insensitively. */
export function isPathCaseInsensitive(value: string): boolean {
  return (
    probePathCaseInsensitiveSync(value) ??
    (process.platform === "darwin" || process.platform === "win32")
  );
}
