import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { ok, type Result } from "@openclaw/normalization-core/result";
import chokidar, { type FSWatcher } from "chokidar";
import { isPathInside } from "../../infra/path-guards.js";
import { createNativeSkillsAncestorWatcher } from "./refresh-ancestor-native.js";
import { teardownSkillsPathWatcher } from "./refresh-watch-close.js";
import type { createSkillsWatchPathFilter } from "./refresh-watch-path.js";
import { shouldUseNativeSkillsWatcher } from "./refresh-watch-transport.js";

type AncestorSubscription = {
  path: string;
  ignored: ReturnType<typeof createSkillsWatchPathFilter>["ignored"];
  ready: () => void;
  unavailable: () => void;
  reconcile: () => void;
  changed: (event: string, path: string) => void;
  raw: (event: string, path: unknown, details: unknown) => void;
  error: (error: Error, observationRoot: string) => void;
};
type AncestorWatcher = {
  watcher: FSWatcher | ReturnType<typeof createNativeSkillsAncestorWatcher>;
  close: () => Promise<Result<void, unknown>>;
  observationRoot: string;
  ready: boolean;
  error?: Error;
  retiring?: Promise<Result<void, unknown>>;
  subscriptions: Set<AncestorSubscription>;
};

// Imported with the refresh owner at Gateway startup, outside turn contexts.
const runInWatcherContext = AsyncLocalStorage.snapshot();
const ancestorWatchers = new Map<string, AncestorWatcher>();

function createAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  subscriptions: Set<AncestorSubscription>,
): Pick<AncestorWatcher, "watcher" | "close" | "observationRoot"> {
  const ignored: AncestorSubscription["ignored"] = (candidate, stats) => {
    let allIgnored = true;
    // Each logical filter records directory-symlink identity for unlink
    // events. Evaluate all of them even when another target admits entry.
    for (const current of subscriptions) {
      if (!current.ignored(candidate, stats)) {
        allIgnored = false;
      }
    }
    return allIgnored;
  };
  return runInWatcherContext(() => {
    if (shouldUseNativeSkillsWatcher(usePolling)) {
      const watcher = createNativeSkillsAncestorWatcher(watchRoot, ignored, () => {
        const current = ancestorWatchers.get(watchRoot);
        if (current?.watcher === watcher && !current.retiring) {
          void replaceAncestorWatcher(watchRoot, usePolling, current);
        }
      });
      watcher.on("reconcile", (_changedPath: string, structural: boolean) => {
        const current = ancestorWatchers.get(watchRoot);
        if (!structural || current?.watcher !== watcher || current.retiring) {
          return;
        }
        // Native Windows names can alias any admitted entry. Do not apply the
        // union or per-subscription lexical filter to this reconciliation hint.
        for (const target of Array.from(subscriptions)) {
          if (current.watcher === watcher && !watcher.closed && subscriptions.has(target)) {
            target.reconcile();
          }
        }
      });
      return { watcher, close: () => watcher.close(), observationRoot: watchRoot };
    }
    const watcher = chokidar.watch(watchRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      usePolling,
      // Only observe the next directory in each missing path. Appearance moves
      // subscriptions to the closest existing ancestor or their recursive root.
      depth: 0,
      ignored,
    });
    let observationRoot = watchRoot;
    if (process.platform === "darwin" && !usePolling) {
      // macOS may keep a moved inode. Observe its parent entry in this
      // same watcher and retain that explicit observation scope separately
      // from the logical watchRoot used for replacement.
      const parent = path.dirname(watchRoot);
      watcher.add(parent);
      observationRoot = parent;
    }
    return { watcher, close: () => teardownSkillsPathWatcher({ watcher }), observationRoot };
  });
}

function observeAncestorWatcher(current: AncestorWatcher): void {
  const { watcher, subscriptions } = current;
  const isCurrent = () => current.watcher === watcher && !current.retiring && !watcher.closed;
  const publish = (notify: (target: AncestorSubscription) => void) => {
    for (const target of Array.from(subscriptions)) {
      if (isCurrent() && subscriptions.has(target)) {
        notify(target);
      }
    }
  };
  watcher.on("ready", () => {
    // Chokidar can emit ready after failing to install its native watch. Keep
    // that generation failed so a later acquisition retries the physical watch.
    if (!isCurrent() || current.error) {
      return;
    }
    current.ready = true;
    publish((target) => target.ready());
  });
  watcher.on("all", (event: string, changedPath: string) => {
    publish((target) => {
      if (isPathInside(changedPath, target.path) || isPathInside(target.path, changedPath)) {
        target.changed(event, changedPath);
      }
    });
  });
  watcher.on("raw", (event: string, rawPath: unknown, details: unknown) => {
    publish((target) => target.raw(event, rawPath, details));
  });
  watcher.on("error", (error: unknown) => {
    if (!isCurrent()) {
      return;
    }
    current.ready = false;
    const watchError = toErrorObject(error, "Skills ancestor watcher failed");
    current.error = watchError;
    publish((target) => target.error(watchError, current.observationRoot));
  });
}

function replaceAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  current: AncestorWatcher,
): Promise<Result<void, unknown>> {
  if (current.retiring) {
    return current.retiring;
  }
  current.ready = false;
  // Retain this exact shared owner's custody while it closes. A late subscriber
  // waits for that close too; unrelated overlapping observers remain independent.
  const retiring = current.close();
  current.retiring = retiring;
  for (const target of Array.from(current.subscriptions)) {
    if (current.subscriptions.has(target)) {
      target.unavailable();
    }
  }
  void retiring.then((result) => {
    if (ancestorWatchers.get(watchRoot) !== current) {
      return;
    }
    if (!result.ok) {
      current.error = toErrorObject(result.error, "Skills ancestor watcher retirement failed");
      for (const target of Array.from(current.subscriptions)) {
        if (current.subscriptions.has(target)) {
          target.error(current.error, current.observationRoot);
        }
      }
      return;
    }
    if (current.subscriptions.size === 0) {
      ancestorWatchers.delete(watchRoot);
      return;
    }
    Object.assign(current, createAncestorWatcher(watchRoot, usePolling, current.subscriptions));
    current.retiring = undefined;
    current.error = undefined;
    observeAncestorWatcher(current);
  });
  return retiring;
}

export function acquireSkillsAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  subscription: AncestorSubscription,
): { release: () => Promise<Result<void, unknown>> } {
  let group = ancestorWatchers.get(watchRoot);
  if (!group) {
    const subscriptions = new Set<AncestorSubscription>([subscription]);
    group = {
      ...createAncestorWatcher(watchRoot, usePolling, subscriptions),
      ready: false,
      subscriptions,
    };
    ancestorWatchers.set(watchRoot, group);
    observeAncestorWatcher(group);
  } else {
    group.subscriptions.add(subscription);
  }
  const current = group;
  const watcher = current.watcher;
  if (current.error && !current.retiring) {
    // Return the release handle before retry notifications can reenter shutdown.
    // Both initial and replacement path owners finish construction in this turn.
    queueMicrotask(() => {
      if (
        ancestorWatchers.get(watchRoot) === current &&
        current.subscriptions.has(subscription) &&
        current.error &&
        !current.retiring
      ) {
        void replaceAncestorWatcher(watchRoot, usePolling, current);
      }
    });
  }
  let released: Promise<Result<void, unknown>> | undefined;
  // A late subscriber cannot wait for another ready event. Recheck its current
  // path before publishing readiness, including creation before registration.
  if (current.ready || current.error) {
    queueMicrotask(() => {
      if (
        ancestorWatchers.get(watchRoot) === current &&
        current.watcher === watcher &&
        current.subscriptions.has(subscription)
      ) {
        if (current.ready && !watcher.closed && !current.retiring) {
          subscription.ready();
        } else if (current.error) {
          subscription.error(current.error, current.observationRoot);
        }
      }
    });
  }
  return {
    release: () => {
      if (released) {
        return released;
      }
      if (current.subscriptions.delete(subscription) && current.subscriptions.size === 0) {
        released = replaceAncestorWatcher(watchRoot, usePolling, current);
      } else {
        released = current.retiring ?? Promise.resolve(ok(undefined));
      }
      return released;
    },
  };
}

export function resetSkillsAncestorWatchersForTest(): void {
  ancestorWatchers.clear();
}
