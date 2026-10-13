import fs from "node:fs";
import path from "node:path";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

type Listener = (filename?: string) => void;
type Directory = {
  path: string;
  listeners: Set<Listener>;
  source?: Source;
};
type Source = { path: string; watcher: fs.FSWatcher; directories: Set<Directory> };

const directories = new Map<string, Directory>();
const sources = new Map<string, Source>();
let fallback: ReturnType<typeof setInterval> | undefined;

function detach(directory: Directory) {
  const source = directory.source;
  directory.source = undefined;
  if (source && source.directories.delete(directory) && !source.directories.size) {
    sources.delete(source.path);
    source.watcher.close();
  }
}

function notify(directory: Directory, filename?: string) {
  const listeners = Array.from(directory.listeners);
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
): { close(): void } {
  const key = path.resolve(directoryPath);
  let directory = directories.get(key);
  if (!directory) {
    directory = { path: key, listeners: new Set() };
    directories.set(key, directory);
    attach(directory);
  }
  const selected = directory;
  const listener: Listener = (filename) => onChange(filename);
  selected.listeners.add(listener);
  fallback ??= runInDetachedAsyncContext(() =>
    setInterval(() => {
      const observed = Array.from(directories.values());
      for (const entry of observed) {
        if (directories.get(entry.path) !== entry) {
          continue;
        }
        if (!entry.source || (entry.source.path !== entry.path && fs.existsSync(entry.path))) {
          detach(entry);
          attach(entry);
        }
        // Revalidate owner facts even when native notifications were dropped.
        notify(entry);
      }
    }, 30_000).unref(),
  );
  return {
    close() {
      if (!selected.listeners.delete(listener) || selected.listeners.size) {
        return;
      }
      directories.delete(key);
      detach(selected);
      if (!directories.size) {
        clearInterval(fallback);
        fallback = undefined;
      }
    },
  };
}
