import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createDeferredCore } from "../../shared/deferred.js";
import { trackSkillsWatcherClose } from "./refresh-watch-close.js";
import { rawPathToString, resolveRawSkillsWatchPath } from "./refresh-watch-path.js";

class NativeSkillsAncestorWatcher extends EventEmitter {
  closed = false;
  private failed = false;
  private watcher?: fs.FSWatcher;
  private readonly closure = createDeferredCore();

  constructor(watchRoot: string, ignored: (candidate: string) => boolean, rearm: () => void) {
    super();
    try {
      this.watcher = fs.watch(watchRoot, (event, filename) => {
        if (this.closed || this.failed) {
          return;
        }
        const name = rawPathToString(filename);
        // Linux reports moves of the watched directory using its own basename.
        // A missing filename likewise requires reconciling the whole ancestor.
        const rootChanged = !name || name === path.basename(watchRoot);
        const details = { watchedPath: watchRoot };
        const changedPath = rootChanged ? watchRoot : resolveRawSkillsWatchPath(name, details);
        if (!changedPath || ignored(changedPath)) {
          return;
        }
        // Reconcile once before raw fanout can promote a missing root; otherwise
        // this same notification would immediately retire the promoted content watch.
        this.emit("all", event === "rename" || rootChanged ? "ancestor" : "change", changedPath);
        if (!this.closed) {
          this.emit("raw", event, filename, details);
        }
        if (rootChanged && !this.closed) {
          // Inotify retains the old inode after replacement. The shared owner
          // rechecks transport admission, including replacement by a symlink.
          rearm();
        }
      });
      this.watcher.on("close", () => this.closure.resolve());
      this.watcher.on("error", (error) => this.fail(error));
    } catch (error) {
      // Let the shared owner install listeners before reporting synchronous failures.
      this.failed = true;
      this.closure.resolve();
      queueMicrotask(() => this.fail(error));
    }
    queueMicrotask(() => {
      if (!this.closed && !this.failed) {
        this.emit("ready");
      }
    });
  }

  private fail(error: unknown): void {
    this.failed = true;
    // Node closes the native handle before an error, without emitting close.
    this.closure.resolve();
    if (!this.closed) {
      this.emit("error", error);
    }
  }

  close(): Promise<void> {
    if (this.closed) {
      return this.closure.promise;
    }
    this.closed = true;
    this.removeAllListeners();
    return trackSkillsWatcherClose(() => {
      this.watcher?.close();
      return this.closure.promise;
    });
  }
}

export function createNativeSkillsAncestorWatcher(
  watchRoot: string,
  ignored: (candidate: string) => boolean,
  rearm: () => void,
) {
  return new NativeSkillsAncestorWatcher(watchRoot, ignored, rearm);
}
