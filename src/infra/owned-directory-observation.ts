import fs from "node:fs";
import path from "node:path";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

type Listener = (filename?: string) => void;
type Directory = {
  path: string;
  listeners: Map<Listener, number>;
  nextFallback: { atMs: number; elapsedAtMs: number };
  source?: Source;
};
type Source = { path: string; watcher: fs.FSWatcher; directories: Set<Directory> };

const directories = new Map<string, Directory>();
const sources = new Map<string, Source>();
let fallback: ReturnType<typeof setTimeout> | undefined;
const REPAIR_INTERVAL_MS = 30_000;
const RECOVERY_INTERVAL_MS = 300_000;

function nextFallback(intervalMs: number): Directory["nextFallback"] {
  const now = Date.now();
  const atMs = (Math.floor(now / intervalMs) + 1) * intervalMs;
  return { atMs, elapsedAtMs: performance.now() + atMs - now };
}

function fallbackRemaining(directory: Directory): number {
  return Math.min(
    directory.nextFallback.atMs - Date.now(),
    directory.nextFallback.elapsedAtMs - performance.now(),
  );
}

function retainEarlierFallback(directory: Directory, deadline: Directory["nextFallback"]): void {
  directory.nextFallback.atMs = Math.min(directory.nextFallback.atMs, deadline.atMs);
  directory.nextFallback.elapsedAtMs = Math.min(
    directory.nextFallback.elapsedAtMs,
    deadline.elapsedAtMs,
  );
}

function fallbackInterval(directory: Directory): number {
  return directory.source?.path === directory.path
    ? Math.min(RECOVERY_INTERVAL_MS, ...directory.listeners.values())
    : REPAIR_INTERVAL_MS;
}

function scheduleFallback() {
  clearTimeout(fallback);
  fallback = undefined;
  if (!directories.size) {
    return;
  }
  const delayMs = Math.min(...Array.from(directories.values(), fallbackRemaining));
  fallback = runInDetachedAsyncContext(() =>
    setTimeout(
      () => {
        for (const entry of Array.from(directories.values())) {
          if (fallbackRemaining(entry) > 0 || directories.get(entry.path) !== entry) {
            continue;
          }
          if (!entry.source || (entry.source.path !== entry.path && fs.existsSync(entry.path))) {
            detach(entry);
            attach(entry);
          }
          // Native events are primary; recovery covers missed notifications.
          entry.nextFallback = nextFallback(fallbackInterval(entry));
          notify(entry);
        }
        scheduleFallback();
      },
      Math.max(0, Math.ceil(delayMs)),
    ).unref(),
  );
}

function detach(directory: Directory) {
  const source = directory.source;
  directory.source = undefined;
  if (source && source.directories.delete(directory) && !source.directories.size) {
    sources.delete(source.path);
    source.watcher.close();
  }
}

function notify(directory: Directory, filename?: string) {
  const listeners = Array.from(directory.listeners.keys());
  for (const listener of listeners) {
    listener(filename);
  }
}

function attach(directory: Directory) {
  let candidate = directory.path;
  while (true) {
    const shared = sources.get(candidate);
    if (shared) {
      shared.directories.add(directory);
      directory.source = shared;
      return;
    }
    try {
      const watcher = runInDetachedAsyncContext(() =>
        fs.watch(candidate, { persistent: false }, (event, filename) => {
          const source = sources.get(candidate);
          if (!source || source.watcher !== watcher) {
            return;
          }
          const affected = [...source.directories];
          for (const entry of affected) {
            notify(
              entry,
              entry.path === candidate ? (filename?.toString() ?? undefined) : undefined,
            );
          }
          // A renamed directory's watcher can remain bound to its retired inode.
          // Child-file renames do not retire the directory or its queued events.
          if (event === "rename") {
            const renamedRoot = !filename || filename === path.basename(candidate);
            const readmit = affected.filter((entry) => renamedRoot || entry.path !== candidate);
            for (const entry of readmit) {
              detach(entry);
            }
            for (const entry of readmit) {
              if (directories.get(entry.path) === entry) {
                attach(entry);
                retainEarlierFallback(entry, nextFallback(fallbackInterval(entry)));
              }
            }
            scheduleFallback();
          }
        }),
      );
      const source: Source = { path: candidate, watcher, directories: new Set([directory]) };
      sources.set(candidate, source);
      directory.source = source;
      watcher.on("error", () => {
        const affected = Array.from(source.directories);
        for (const entry of affected) {
          detach(entry);
          notify(entry);
          retainEarlierFallback(entry, nextFallback(REPAIR_INTERVAL_MS));
        }
        scheduleFallback();
      });
      return;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return;
      }
      candidate = parent;
    }
  }
}

/** Shared invalidation for process-owned facts; consumers retain and refresh their own state. */
export function observeOwnedDirectory(
  directoryPath: string,
  onChange: Listener,
  options?: { recoveryIntervalMs?: 30_000 },
): { close(): void } {
  const key = path.resolve(directoryPath);
  let directory = directories.get(key);
  if (!directory) {
    directory = {
      path: key,
      listeners: new Map(),
      nextFallback: { atMs: Infinity, elapsedAtMs: Infinity },
    };
    directories.set(key, directory);
    attach(directory);
  }
  const selected = directory;
  const listener: Listener = (filename) => onChange(filename);
  selected.listeners.set(listener, options?.recoveryIntervalMs ?? RECOVERY_INTERVAL_MS);
  retainEarlierFallback(selected, nextFallback(fallbackInterval(selected)));
  scheduleFallback();
  return {
    close() {
      if (!selected.listeners.delete(listener) || selected.listeners.size) {
        return;
      }
      directories.delete(key);
      detach(selected);
      if (!directories.size) {
        clearTimeout(fallback);
        fallback = undefined;
      } else {
        scheduleFallback();
      }
    },
  };
}
