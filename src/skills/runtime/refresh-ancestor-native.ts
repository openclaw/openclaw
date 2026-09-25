import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import { hasErrnoCode } from "../../infra/errno.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { trackSkillsWatcherClose } from "./refresh-watch-close.js";
import { rawPathToString, resolveRawSkillsWatchPath } from "./refresh-watch-path.js";

type RootAdmission = "ancestor" | "directory" | "entry-parent";

export class SkillsNativeWatchInvalidatedError extends Error {}

export function isNativeSkillsStructuralChange(changedPath: string): boolean {
  try {
    const state = fs.lstatSync(changedPath);
    return state.isDirectory() || state.isSymbolicLink();
  } catch {
    // The owned scan reconciles absence or reports its authoritative read error.
    return true;
  }
}

function readDirectoryState(watchRoot: string, entryParent: boolean): fs.BigIntStats {
  const state = entryParent
    ? fs.statSync(watchRoot, { bigint: true })
    : fs.lstatSync(watchRoot, { bigint: true });
  if (!state.isDirectory()) {
    throw new SkillsNativeWatchInvalidatedError(
      `Skills content watch requires a directory: ${watchRoot}`,
    );
  }
  return state;
}

function readRootState(watchRoot: string, entryParent = false): fs.BigIntStats | undefined {
  try {
    return readDirectoryState(watchRoot, entryParent);
  } catch {
    return undefined;
  }
}

function sameRootIdentity(left: fs.BigIntStats | undefined, right: fs.BigIntStats | undefined) {
  return (
    left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino
  );
}

function sameRootState(left: fs.BigIntStats | undefined, right: fs.BigIntStats | undefined) {
  return (
    left !== undefined &&
    right !== undefined &&
    sameRootIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.ctimeNs === right.ctimeNs
  );
}

class NativeSkillsAncestorWatcher extends EventEmitter {
  closed = false;
  private failed = false;
  private watcher?: fs.FSWatcher;
  private readonly identity?: fs.BigIntStats;
  private readonly closure = createDeferredCore();
  private closing?: Promise<Result<void, unknown>>;

  get admitted(): boolean {
    return !this.closed && !this.failed;
  }

  get admittedIdentity(): fs.BigIntStats | undefined {
    return this.admitted ? this.identity : undefined;
  }

  constructor(
    watchRoot: string,
    ignored: (candidate: string) => boolean,
    rearm: () => void,
    admission: RootAdmission,
  ) {
    super();
    const requireExactRoot = admission !== "ancestor";
    // An admitted symbolic leaf is observed through its logical parent, even
    // when that parent is an alias. This never scans or watches the leaf target;
    // recursive target admission remains owned by watch-target preparation.
    const entryParent = admission === "entry-parent";
    try {
      let observationRoot = watchRoot;
      for (;;) {
        let state: fs.BigIntStats | undefined;
        try {
          state = requireExactRoot
            ? readDirectoryState(observationRoot, entryParent)
            : fs.lstatSync(observationRoot, { bigint: true });
        } catch (error) {
          if (
            requireExactRoot ||
            (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR"))
          ) {
            throw error;
          }
        }
        if (state?.isDirectory()) {
          break;
        }
        const parent = path.dirname(observationRoot);
        if (parent === observationRoot) {
          throw new Error(`No directory can observe Skills root: ${watchRoot}`);
        }
        observationRoot = parent;
      }
      // Exact admission preserves real read errors. Only positively observed
      // namespace changes may restart a child scan; unknown facts remain fatal.
      const snapshot = requireExactRoot ? readDirectoryState : readRootState;
      const before = snapshot(observationRoot, entryParent);
      const nativeRootPath = path.toNamespacedPath(observationRoot);
      const rootName = path.basename(observationRoot);
      this.watcher = fs.watch(observationRoot, (event, filename) => {
        if (this.closed || this.failed) {
          return;
        }
        const name = rawPathToString(filename);
        // Windows reports deleted roots by their full native path. Basenames
        // can also name children, so only the explicit self path bypasses the
        // bracketed identity check.
        const explicitRootChange = !name || (event === "rename" && name === nativeRootPath);
        const currentRoot =
          !explicitRootChange && (event === "rename" || name === rootName)
            ? readRootState(observationRoot, entryParent)
            : undefined;
        // Inotify shares the first peer's path spelling for self-events. Check
        // identity before filtering any rename, but ignore child-induced ctime
        // changes unless the name also identifies our own root.
        const rootChanged =
          explicitRootChange ||
          (event === "rename" && !sameRootIdentity(registeredIdentity, currentRoot)) ||
          (name === rootName && !sameRootState(registeredRoot, currentRoot));
        const details = { watchedPath: observationRoot };
        const changedPath = rootChanged
          ? observationRoot
          : resolveRawSkillsWatchPath(name, details);
        if (!changedPath) {
          return;
        }
        const reconcileEntry = process.platform === "win32" && !rootChanged;
        if (reconcileEntry) {
          // Windows can retain short names for removed entries or failed name
          // expansion. Reconcile admitted paths before any lexical filter;
          // this does not mean the observed directory itself was replaced.
          this.emit(
            "reconcile",
            changedPath,
            event !== "change" || isNativeSkillsStructuralChange(changedPath),
          );
        }
        if (this.closed || this.failed || ignored(changedPath)) {
          return;
        }
        // Reconcile once before raw fanout can promote a missing root; otherwise
        // this same notification would immediately retire the promoted content watch.
        if (!reconcileEntry) {
          this.emit("all", event === "rename" || rootChanged ? "ancestor" : "change", changedPath);
        }
        if (!this.closed && !this.failed) {
          this.emit("raw", event, filename, details);
        }
        if (
          !this.closed &&
          !this.failed &&
          (rootChanged || (observationRoot !== watchRoot && readRootState(watchRoot, entryParent)))
        ) {
          // Inotify retains the old inode after replacement. The shared owner
          // rechecks transport admission, including replacement by a symlink.
          rearm();
        }
      });
      this.watcher.on("close", () => this.closure.resolve());
      this.watcher.on("error", (error: NodeJS.ErrnoException) => {
        this.failed = true;
        // Node retires the native handle before error, without emitting close.
        // Fence it before structural callbacks can synchronously replace owners.
        this.closure.resolve();
        if (this.closed) {
          return;
        }
        if (process.platform === "win32" && error.code === "EPERM") {
          try {
            if (entryParent) {
              fs.statSync(observationRoot);
            } else {
              fs.lstatSync(observationRoot);
            }
          } catch (stateError) {
            if (hasErrnoCode(stateError, "ENOENT") || hasErrnoCode(stateError, "ENOTDIR")) {
              // Windows can report deletion as EPERM. Confirm loss of the
              // actual observer, not a missing descendant of a healthy parent.
              this.emit("all", "ancestor", observationRoot);
              if (!this.closed) {
                rearm();
              }
              return;
            }
          }
        }
        this.emit("error", error);
      });
      // A post-registration snapshot alone could describe a replacement rather
      // than the watched directory. Never adopt changed or unknown facts later.
      const after = snapshot(observationRoot, entryParent);
      const registeredIdentity = sameRootIdentity(before, after) ? after : undefined;
      if (requireExactRoot && !registeredIdentity) {
        throw new SkillsNativeWatchInvalidatedError(
          `Skills directory changed during native registration: ${watchRoot}`,
        );
      }
      this.identity = registeredIdentity;
      const registeredRoot = sameRootState(before, after) ? after : undefined;
      queueMicrotask(() => {
        if (this.closed || this.failed) {
          return;
        }
        // The requested directory can return before its fallback parent starts
        // observing. No parent event is owed, so repair coverage before ready.
        if (observationRoot !== watchRoot && readRootState(watchRoot, entryParent)) {
          rearm();
          return;
        }
        this.emit("ready");
      });
    } catch (error) {
      // Let the shared owner install listeners before reporting synchronous failures.
      this.failed = true;
      if (this.watcher) {
        this.closing = trackSkillsWatcherClose(() => {
          this.watcher!.close();
          return this.closure.promise;
        });
      } else {
        this.closure.resolve();
      }
      queueMicrotask(() => {
        if (!this.closed) {
          this.emit("error", error);
        }
      });
    }
  }

  close(): Promise<Result<void, unknown>> {
    this.closed = true;
    this.removeAllListeners();
    if (this.closing) {
      return this.closing;
    }
    this.closing = trackSkillsWatcherClose(() => {
      this.watcher?.close();
      return this.closure.promise;
    });
    return this.closing;
  }
}

export function createNativeSkillsAncestorWatcher(
  watchRoot: string,
  ignored: (candidate: string) => boolean,
  rearm: () => void,
  admission: RootAdmission = "ancestor",
) {
  return new NativeSkillsAncestorWatcher(watchRoot, ignored, rearm, admission);
}
