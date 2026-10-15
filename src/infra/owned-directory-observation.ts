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
let fallbackDueAtMs = Infinity;
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

function scheduleFallback(changed?: Directory) {
  if (!directories.size) {
    return;
  }
  // Only recovery scans the fleet; mutations can advance the existing timer.
  const delayMs = changed
    ? fallbackRemaining(changed)
    : Math.min(...Array.from(directories.values(), fallbackRemaining));
  const dueAtMs = performance.now() + Math.max(0, Math.ceil(delayMs));
  if (fallback && fallbackDueAtMs <= dueAtMs) {
    return;
  }
  clearTimeout(fallback);
  fallbackDueAtMs = dueAtMs;
  fallback = runInDetachedAsyncContext(() =>
    setTimeout(
      () => {
        fallback = undefined;
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

// libuv aborts the process when a Windows directory watch was opened through an
// 8.3 short path (e.g. C:\Users\RUNNER~1\...) and a child event resolves to its
// long form (libuv/libuv#5010, fixed upstream by libuv/libuv#5152 but not yet in
// shipped Node). Watch the long form; the short spelling stays the shared key.
function watchPath(candidate: string): string {
  return process.platform === "win32" && candidate.includes("~")
    ? fs.realpathSync.native(candidate)
    : candidate;
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
        fs.watch(watchPath(candidate), { persistent: false }, (event, filename) => {
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
            const renamed = filename?.toString();
            const renamedRoot = !renamed || renamed === path.basename(candidate);
            // An absent directory waits on its nearest ancestor. Only the next segment
            // toward it can move that attach point; closing a native watch for other
            // children (SQLite sidecars) can block the main thread for seconds on macOS.
            const readmit = affected.filter(
              (entry) =>
                renamedRoot ||
                (entry.path !== candidate &&
                  path.relative(candidate, entry.path).split(path.sep, 1)[0] === renamed),
            );
            for (const entry of readmit) {
              detach(entry);
            }
            for (const entry of readmit) {
              if (directories.get(entry.path) === entry) {
                attach(entry);
                retainEarlierFallback(entry, nextFallback(fallbackInterval(entry)));
                scheduleFallback(entry);
              }
            }
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
          scheduleFallback(entry);
        }
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
  scheduleFallback(selected);
  return {
    close() {
      if (!selected.listeners.delete(listener) || selected.listeners.size) {
        return;
      }
      directories.delete(key);
      detach(selected);
      // Closing the earliest subscriber may leave one harmless early recovery pass.
      if (!directories.size) {
        clearTimeout(fallback);
        fallback = undefined;
      }
    },
  };
}
