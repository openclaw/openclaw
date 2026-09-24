import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import chokidar, { type FSWatcher } from "chokidar";
import { isPathInside } from "../../infra/path-guards.js";
import { createNativeSkillsAncestorWatcher } from "./refresh-ancestor-native.js";
import { teardownSkillsPathWatcher } from "./refresh-watch-close.js";
import type { createSkillsWatchPathFilter } from "./refresh-watch-path.js";

type AncestorSubscription = {
  path: string;
  ignored: ReturnType<typeof createSkillsWatchPathFilter>["ignored"];
  ready: () => void;
  changed: (event: string, path: string) => void;
  raw: (event: string, path: unknown, details: unknown) => void;
  error: (error: Error) => void;
};
type AncestorWatcher = {
  watcher: FSWatcher | ReturnType<typeof createNativeSkillsAncestorWatcher>;
  close: () => Promise<void>;
  ready: boolean;
  error?: Error;
  subscriptions: Set<AncestorSubscription>;
};

// Imported with the refresh owner at Gateway startup, outside turn contexts.
const runInWatcherContext = AsyncLocalStorage.snapshot();
const ancestorWatchers = new Map<string, AncestorWatcher>();

function useNativeAncestorWatcher(watchRoot: string, usePolling: boolean): boolean {
  if (process.platform !== "linux" || process.versions.bun || usePolling) {
    return false;
  }
  try {
    // fs.watch follows a symlink. Keep Chokidar's parent observation for links
    // and its existing recovery/error handling for a root that disappeared.
    return fs.lstatSync(watchRoot).isDirectory();
  } catch {
    return false;
  }
}

function createAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  subscriptions: Set<AncestorSubscription>,
): Pick<AncestorWatcher, "watcher" | "close"> {
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
    if (useNativeAncestorWatcher(watchRoot, usePolling)) {
      // Linux supplies child names directly. Chokidar enumerates/stats every
      // sibling before its ignored filter can reject unrelated state-file work.
      const watcher = createNativeSkillsAncestorWatcher(watchRoot, ignored, () => {
        const current = ancestorWatchers.get(watchRoot);
        if (current?.watcher === watcher) {
          replaceAncestorWatcher(watchRoot, usePolling, current);
        }
      });
      return { watcher, close: () => watcher.close() };
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
    return { watcher, close: () => teardownSkillsPathWatcher({ watcher }) };
  });
}

function observeAncestorWatcher(current: AncestorWatcher): void {
  const { watcher, subscriptions } = current;
  const isCurrent = () => current.watcher === watcher && !watcher.closed;
  watcher.on("ready", () => {
    // Chokidar can emit ready after failing to install its native watch. Keep
    // that generation failed so a later acquisition retries the physical watch.
    if (!isCurrent() || current.error) {
      return;
    }
    current.ready = true;
    for (const target of Array.from(subscriptions)) {
      if (isCurrent() && subscriptions.has(target)) {
        target.ready();
      }
    }
  });
  watcher.on("all", (event: string, changedPath: string) => {
    if (!isCurrent()) {
      return;
    }
    for (const target of Array.from(subscriptions)) {
      if (
        isCurrent() &&
        subscriptions.has(target) &&
        (isPathInside(changedPath, target.path) || isPathInside(target.path, changedPath))
      ) {
        target.changed(event, changedPath);
      }
    }
  });
  watcher.on("raw", (event: string, rawPath: unknown, details: unknown) => {
    if (!isCurrent()) {
      return;
    }
    for (const target of Array.from(subscriptions)) {
      if (isCurrent() && subscriptions.has(target)) {
        target.raw(event, rawPath, details);
      }
    }
  });
  watcher.on("error", (error: unknown) => {
    if (!isCurrent()) {
      return;
    }
    current.ready = false;
    const watchError = toErrorObject(error, "Skills ancestor watcher failed");
    current.error = watchError;
    for (const target of Array.from(subscriptions)) {
      if (isCurrent() && subscriptions.has(target)) {
        target.error(watchError);
      }
    }
  });
}

function replaceAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  current: AncestorWatcher,
): void {
  const closeRetired = current.close;
  Object.assign(current, createAncestorWatcher(watchRoot, usePolling, current.subscriptions));
  current.ready = false;
  current.error = undefined;
  observeAncestorWatcher(current);
  // Releases retain this group and its subscriptions across native retries/rearms.
  void closeRetired();
}

export function acquireSkillsAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  subscription: AncestorSubscription,
): { release: () => void } {
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
    if (group.error) {
      replaceAncestorWatcher(watchRoot, usePolling, group);
    }
  }
  const current = group;
  const watcher = current.watcher;
  // A late subscriber cannot wait for another ready event. Recheck its current
  // path before publishing readiness, including creation before registration.
  if (current.ready || current.error) {
    queueMicrotask(() => {
      if (
        current.watcher === watcher &&
        !watcher.closed &&
        current.subscriptions.has(subscription)
      ) {
        if (current.ready) {
          subscription.ready();
        } else if (current.error) {
          subscription.error(current.error);
        }
      }
    });
  }
  return {
    release: () => {
      if (current.subscriptions.delete(subscription) && current.subscriptions.size === 0) {
        ancestorWatchers.delete(watchRoot);
        void current.close();
      }
    },
  };
}
