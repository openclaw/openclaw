// Path case-sensitivity probes and component-aware identity keys
// (agentDir collisions, trusted safe-bin dirs, …).
//
// Whole-path folding is unsafe across mixed mount / per-directory case
// semantics: one boolean must not lowercase every component. Identity walks
// components and folds only where the parent resolves children case-insensitively.
import fs from "node:fs";
import path from "node:path";

/** Probe whether `dir` resolves children case-insensitively. null = unknown. */
export type PathChildCaseProbe = (dir: string) => boolean | null;

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

function sameFsObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function hasAsciiLetters(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

/**
 * Probe whether children of `dir` are resolved case-insensitively.
 * Prefer an existing lettered entry (works on read-only system dirs);
 * otherwise create a temporary marker and remove it.
 * Returns null when the directory cannot be probed.
 */
export function probeDirectoryChildCaseInsensitive(dir: string): boolean | null {
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!hasAsciiLetters(entry)) {
        continue;
      }
      const swapped = swapAsciiCase(entry);
      if (swapped === entry) {
        continue;
      }
      const originalPath = path.join(dir, entry);
      const alternatePath = path.join(dir, swapped);
      try {
        const original = fs.statSync(originalPath);
        try {
          const alternate = fs.statSync(alternatePath);
          return sameFsObject(original, alternate);
        } catch {
          // Original child exists, alternate spelling does not → case-sensitive.
          return false;
        }
      } catch {
        // Entry disappeared between readdir and stat; try another.
      }
    }
  } catch {
    // Not readable; fall through to a write probe when possible.
  }

  // No usable existing entry: create a short-lived child marker.
  // Child probe (not parent-name swap) is required at mount boundaries.
  const markerName = `.openclawCaseProbe-${process.pid}-${Date.now().toString(36)}`;
  const markerPath = path.join(dir, markerName);
  const swappedPath = swapAsciiCase(markerPath);
  if (swappedPath === markerPath) {
    return process.platform === "win32";
  }

  try {
    fs.writeFileSync(markerPath, "x", { flag: "wx" });
  } catch {
    return null;
  }

  try {
    const original = fs.statSync(markerPath);
    try {
      const alternate = fs.statSync(swappedPath);
      return sameFsObject(original, alternate);
    } catch {
      return false;
    }
  } finally {
    fs.rmSync(markerPath, { force: true });
  }
}

/**
 * True when `value` lives under a directory whose *child* lookups fold case.
 * Walks to the closest existing directory so configured paths need not exist yet.
 * Prefer {@link canonicalizePathIdentity} for multi-component identity keys.
 */
export function pathCaseInsensitive(value: string): boolean {
  return childLookupFoldsCase(path.resolve(value), probeDirectoryChildCaseInsensitive);
}

/**
 * Whether children of `parent` fold case.
 * Tries the logical parent first (injected probes / existing dirs), then walks
 * to the closest existing ancestor for production probes on absent paths.
 * Unknown / unreadable → false (fail-closed: do not invent equality).
 */
function childLookupFoldsCase(parent: string, probe: PathChildCaseProbe): boolean {
  let candidate = parent;
  for (;;) {
    const probed = probe(candidate);
    if (probed === true) {
      return true;
    }
    if (probed === false) {
      return false;
    }
    // null: probe could not answer (missing / unreadable). Prefer an existing
    // ancestor so production child markers still work for absent leaf paths.
    try {
      const stats = fs.statSync(candidate);
      if (stats.isDirectory()) {
        // Existing dir answered null → fail-closed (do not fold).
        return false;
      }
    } catch {
      // Missing path: walk up.
    }

    const up = path.dirname(candidate);
    if (up === candidate) {
      // Unknown root: Windows volumes are case-insensitive by default; POSIX is not.
      // Fail-closed on POSIX (preserve case) matches safe-bin trust needs.
      return process.platform === "win32";
    }
    candidate = up;
  }
}

export type CanonicalizePathIdentityOptions = {
  /**
   * Optional probe for unit tests / mixed-boundary simulation.
   * Receives the logical parent path built so far (may not exist yet).
   * Production default probes the closest existing directory.
   */
  probeChildCaseInsensitive?: PathChildCaseProbe;
};

/**
 * Component-aware path identity key.
 *
 * Walks absolute path components left-to-right. Folds a component to lowercase
 * only when that component's parent resolves children case-insensitively.
 * Case-sensitive ancestors keep distinct spellings (`Foo` vs `foo`) even when a
 * descendant mount is case-insensitive — fixing whole-path folding false aliases.
 *
 * Fail-closed: unknown parent probes do not fold (safe for trusted-bin compare).
 */
export function canonicalizePathIdentity(
  value: string,
  options?: CanonicalizePathIdentityOptions,
): string {
  const resolved = path.resolve(value);
  const probe = options?.probeChildCaseInsensitive ?? probeDirectoryChildCaseInsensitive;
  const parsed = path.parse(resolved);
  // Root (/, C:\, \\server\share\) has no parent component to fold.
  let built = parsed.root;
  const relative = resolved.slice(parsed.root.length);
  if (!relative) {
    return built;
  }
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  const foldsCache = new Map<string, boolean>();

  for (const part of parts) {
    let folds = foldsCache.get(built);
    if (folds === undefined) {
      // Injected probes answer for the logical parent (tests); production
      // probes walk to the closest existing directory inside childLookupFoldsCase.
      folds = childLookupFoldsCase(built, probe);
      foldsCache.set(built, folds);
    }
    const segment = folds ? part.toLowerCase() : part;
    built =
      built.endsWith(path.sep) || built === "" ? `${built}${segment}` : path.join(built, segment);
  }
  return built;
}
