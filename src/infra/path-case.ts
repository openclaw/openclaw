// Detects path-local filesystem case semantics without mutating the filesystem.
import fs from "node:fs";
import path from "node:path";

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

function sameFsObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Returns whether the target path's nearest existing filesystem is case-insensitive. */
export function isPathCaseInsensitive(value: string): boolean {
  let candidate = value;
  for (;;) {
    const swapped = swapAsciiCase(candidate);
    if (swapped !== candidate) {
      try {
        const original = fs.statSync(candidate);
        try {
          const alternate = fs.statSync(swapped);
          return sameFsObject(original, alternate);
        } catch {
          return false;
        }
      } catch {
        // The target may not exist yet; probe its closest existing parent.
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return process.platform === "win32";
    }
    candidate = parent;
  }
}
