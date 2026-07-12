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

function probeDirectoryEntry(dir: string, name: string): boolean | undefined {
  const swapped = swapAsciiCase(name);
  if (swapped === name) {
    return undefined;
  }
  try {
    const names = fs.readdirSync(dir);
    if (names.includes(swapped)) {
      // Two exact case variants can coexist only when lookup is case-sensitive.
      return false;
    }
    const original = fs.lstatSync(path.join(dir, name));
    try {
      const alternate = fs.lstatSync(path.join(dir, swapped));
      return sameFsObject(original, alternate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
    }
  } catch {
    return undefined;
  }
}

function probeDirectoryContents(dir: string): boolean | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const result = probeDirectoryEntry(dir, name);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

function defaultPathCaseInsensitive(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/** Returns whether the target path's filesystem matches names case-insensitively. */
export function isPathCaseInsensitive(value: string): boolean {
  const resolved = path.resolve(value);
  try {
    fs.lstatSync(resolved);
    const direct = probeDirectoryEntry(path.dirname(resolved), path.basename(resolved));
    return direct ?? defaultPathCaseInsensitive();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return defaultPathCaseInsensitive();
    }
  }

  let candidate = path.dirname(resolved);
  for (;;) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        // The missing entry will be created inside this directory, so probe
        // lookup within it rather than the mount point's name in its parent.
        return probeDirectoryContents(candidate) ?? defaultPathCaseInsensitive();
      }
    } catch {
      // Keep walking to the nearest readable existing directory.
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return defaultPathCaseInsensitive();
    }
    candidate = parent;
  }
}
