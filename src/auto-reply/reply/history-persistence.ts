import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DEBOUNCE_MS = 5_000;

function loadFromDisk<T>(filePath: string): [string, T[]][] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, T[]>);
    }
  } catch {
    // File doesn't exist or is invalid; start with empty map
  }
  return [];
}

function saveToDiskSync<T>(filePath: string, map: Map<string, T[]>): void {
  const data: Record<string, T[]> = {};
  for (const [key, value] of map) {
    data[key] = value;
  }
  const json = JSON.stringify(data, null, 2);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") {
    fs.writeFileSync(filePath, json, { encoding: "utf-8" });
    return;
  }

  // Atomic write: tmp → rename
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, json, { mode: 0o600, encoding: "utf-8" });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, json, { mode: 0o600, encoding: "utf-8" });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Shared exit-flush registry
//
// A single `process.on("exit")` listener flushes all active persistent maps.
// This avoids leaking one listener per map and the MaxListenersExceededWarning
// that would follow when many maps are created (e.g. in tests).
// ---------------------------------------------------------------------------

const activeMaps: Array<() => void> = [];
let exitHookRegistered = false;

function registerFlush(flush: () => void): void {
  activeMaps.push(flush);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on("exit", () => {
      for (const fn of activeMaps) {
        fn();
      }
    });
  }
}

/**
 * Create a Map that automatically persists to disk on changes.
 *
 * On creation the map is populated from the JSON file at `filePath` (if it
 * exists).  Whenever `Map.set` or `Map.delete` mutates the map the change is
 * scheduled for a debounced write so that bursts of mutations result in a
 * single I/O operation.  Pending changes are flushed synchronously on process
 * exit to avoid data loss during graceful shutdown.
 */
export function createPersistentHistoryMap<T>(
  filePath: string,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): Map<string, T[]> {
  const entries = loadFromDisk<T>(filePath);
  const map = new Map<string, T[]>(entries);

  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const flushSync = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (dirty) {
      try {
        saveToDiskSync(filePath, map);
      } catch {
        // Best-effort on exit
      }
      dirty = false;
    }
  };

  registerFlush(flushSync);

  const scheduleSave = () => {
    dirty = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try {
          saveToDiskSync(filePath, map);
        } catch {
          // Best-effort; will retry on next change
        }
        dirty = false;
      }
    }, debounceMs);
    // Don't keep the process alive just for the debounce timer
    saveTimer.unref();
  };

  const originalSet = map.set.bind(map);
  map.set = function (key: string, value: T[]): typeof map {
    originalSet(key, value);
    scheduleSave();
    return map;
  };

  const originalDelete = map.delete.bind(map);
  map.delete = function (key: string): boolean {
    const result = originalDelete(key);
    if (result) {
      scheduleSave();
    }
    return result;
  };

  return map;
}
