import fs from "node:fs/promises";
import path from "node:path";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { watchDirectory, type DirectoryWatch } from "./directory-watch-host.js";
import { isPathInside } from "./path-guards.js";

// Missing event/filename means recovery or an unclassified notification, not a content write.
type Listener = (filename?: string, event?: string) => void;
type Directory = {
  key: string;
  path: string;
  watchRoot: string;
  recursive: boolean;
  reconcileIntervalMs: number;
  listeners: readonly Listener[];
  nextFallback: { atMs: number; elapsedAtMs: number };
  source?: Source;
};
type Source = {
  key: string;
  path: string;
  watcher: DirectoryWatch;
  admitted: boolean;
  directories: readonly Directory[];
};

const directories = new Map<string, Directory>();
const sources = new Map<string, Source>();
let fallback: ReturnType<typeof setTimeout> | undefined;
let fallbackDueAtMs = Infinity;
const REPAIR_INTERVAL_MS = 30_000;

function nextFallback(intervalMs = REPAIR_INTERVAL_MS): Directory["nextFallback"] {
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
        void reconcile();
      },
      Math.max(0, Math.ceil(delayMs)),
    ).unref(),
  );
}

async function reconcile() {
  fallback = undefined;
  const due = Array.from(directories.values()).filter((entry) => fallbackRemaining(entry) <= 0);
  const readmit = new Map<Directory, Source | undefined>();
  for (const entry of due) {
    entry.nextFallback = nextFallback(entry.reconcileIntervalMs);
    const source = entry.source;
    const readmissionNeeded =
      !source ||
      !(await fs.access(source.path).then(
        () => true,
        () => false,
      )) ||
      (source.path !== entry.path &&
        (await fs.access(entry.path).then(
          () => true,
          () => false,
        )));
    if (readmissionNeeded && entry.source === source) {
      for (const shared of source?.directories ?? [entry]) {
        readmit.set(shared, source);
      }
    }
  }
  // A subscription can close while the filesystem check is pending.
  for (const [entry, source] of readmit) {
    if (directories.get(entry.key) !== entry || entry.source !== source) {
      readmit.delete(entry);
    }
  }
  // Release every subscriber before reopening a shared watch, otherwise
  // one remaining subscriber keeps the retired directory handle alive.
  for (const entry of readmit.keys()) {
    detach(entry);
  }
  for (const entry of readmit.keys()) {
    attach(entry);
  }
  for (const entry of due) {
    if (directories.get(entry.key) !== entry) {
      continue;
    }
    // Native events are primary; recovery covers missed notifications.
    notify(entry);
  }
  scheduleFallback();
}

function detach(directory: Directory) {
  const source = directory.source;
  directory.source = undefined;
  if (!source) {
    return;
  }
  source.directories = source.directories.filter((entry) => entry !== directory);
  if (!source.directories.length) {
    sources.delete(source.key);
    source.watcher.close();
  }
}

function notify(directory: Directory, filename?: string, event?: string) {
  for (const listener of directory.listeners) {
    listener(filename, event);
  }
}

function attach(directory: Directory, candidate = directory.watchRoot) {
  // Missing roots observe only their next ancestor segment, never its whole tree.
  const recursive = directory.recursive && candidate === directory.watchRoot;
  const sourceKey = JSON.stringify([candidate, recursive]);
  const shared = sources.get(sourceKey);
  if (shared) {
    shared.directories = [...shared.directories, directory];
    directory.source = shared;
    return;
  }
  const candidateName = path.basename(candidate);
  const watcher = runInDetachedAsyncContext(() =>
    watchDirectory(
      candidate,
      (event, filename) => {
        const source = sources.get(sourceKey);
        if (!source || source.watcher !== watcher) {
          return;
        }
        source.admitted = true;
        // Attach/detach replace this snapshot, including during reentrant delivery.
        const affected = source.directories;
        const renamedRoot = event === "rename" && (!filename || filename === candidateName);
        let changedPath: string | undefined;
        for (const entry of affected) {
          if (
            entry.path === candidate ||
            !filename ||
            renamedRoot ||
            isPathInside(entry.path, (changedPath ??= path.resolve(candidate, filename))) ||
            isPathInside(changedPath, entry.path)
          ) {
            notify(entry, entry.path === candidate ? filename : undefined, event);
          }
        }
        // A renamed directory's watcher can remain bound to its retired inode.
        // Child-file renames do not retire the directory or its queued events.
        if (event === "rename") {
          // An absent directory waits on its nearest ancestor. Only the next segment
          // toward it can move that attach point; closing a native watch for other
          // children (SQLite sidecars) can block the main thread for seconds on macOS.
          let readmit: Directory[] | undefined;
          for (const entry of affected) {
            if (
              renamedRoot ||
              (entry.watchRoot !== candidate &&
                filename !== undefined &&
                isPathInside((changedPath ??= path.resolve(candidate, filename)), entry.watchRoot))
            ) {
              (readmit ??= []).push(entry);
            }
          }
          if (!readmit) {
            return;
          }
          for (const entry of readmit) {
            detach(entry);
          }
          for (const entry of readmit) {
            if (directories.get(entry.key) === entry) {
              attach(entry);
              retainEarlierFallback(entry, nextFallback(entry.reconcileIntervalMs));
              scheduleFallback(entry);
            }
          }
        }
      },
      recursive,
    ),
  );
  const source: Source = {
    key: sourceKey,
    path: candidate,
    watcher,
    admitted: false,
    directories: [directory],
  };
  sources.set(sourceKey, source);
  directory.source = source;
  watcher.on("error", (_error, pathUnavailable) => {
    for (const entry of source.directories) {
      detach(entry);
      const parent = path.dirname(candidate);
      if (pathUnavailable && !source.admitted && parent !== candidate) {
        attach(entry, parent);
        continue;
      }
      notify(entry);
      retainEarlierFallback(entry, nextFallback());
      scheduleFallback(entry);
    }
  });
}

/** Shared invalidation for process-owned facts; consumers retain and refresh their own state. */
export function observeOwnedDirectory(
  directoryPath: string,
  onChange: Listener,
  options: {
    recursive?: boolean;
    reconcileIntervalMs?: number;
    /** Ancestor that owns the native handle; events remain scoped to directoryPath. */
    watchRoot?: string;
  } = {},
): { close(): void; isWatching(): boolean } {
  const directory = path.resolve(directoryPath);
  const watchRoot = options.watchRoot ? path.resolve(options.watchRoot) : directory;
  const recursive = options.recursive ?? false;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? REPAIR_INTERVAL_MS;
  const key = JSON.stringify([directory, watchRoot, recursive, reconcileIntervalMs]);
  let selected = directories.get(key);
  if (!selected) {
    selected = {
      key,
      path: directory,
      watchRoot,
      recursive,
      reconcileIntervalMs,
      listeners: [],
      nextFallback: { atMs: Infinity, elapsedAtMs: Infinity },
    };
    directories.set(key, selected);
    attach(selected);
  }
  const listener: Listener = (filename, event) => onChange(filename, event);
  selected.listeners = [...selected.listeners, listener];
  retainEarlierFallback(selected, nextFallback(reconcileIntervalMs));
  scheduleFallback(selected);
  return {
    isWatching: () => selected.listeners.includes(listener) && selected.source !== undefined,
    close() {
      selected.listeners = selected.listeners.filter((entry) => entry !== listener);
      if (selected.listeners.length || directories.get(key) !== selected) {
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
