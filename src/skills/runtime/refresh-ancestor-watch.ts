import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import chokidar, { type FSWatcher } from "chokidar";
import { isPathInside } from "../../infra/path-guards.js";
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
  watcher: FSWatcher;
  ready: boolean;
  error?: Error;
  subscriptions: Set<AncestorSubscription>;
};

// Imported with the refresh owner at Gateway startup, outside turn contexts.
const runInWatcherContext = AsyncLocalStorage.snapshot();
const ancestorWatchers = new Map<string, AncestorWatcher>();

function createAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  subscriptions: Set<AncestorSubscription>,
): FSWatcher {
  return runInWatcherContext(() =>
    chokidar.watch(watchRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      usePolling,
      // Only observe the next directory in each missing path. Appearance moves
      // subscriptions to the closest existing ancestor or their recursive root.
      depth: 0,
      ignored: (candidate, stats) => {
        let ignored = true;
        // Each logical filter records directory-symlink identity for unlink
        // events. Evaluate all of them even when another target admits entry.
        for (const current of subscriptions) {
          if (!current.ignored(candidate, stats)) {
            ignored = false;
          }
        }
        return ignored;
      },
    }),
  );
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
  watcher.on("all", (event, changedPath) => {
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
  watcher.on("raw", (event, rawPath, details) => {
    if (!isCurrent()) {
      return;
    }
    for (const target of Array.from(subscriptions)) {
      if (isCurrent() && subscriptions.has(target)) {
        target.raw(event, rawPath, details);
      }
    }
  });
  watcher.on("error", (error) => {
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

export function acquireSkillsAncestorWatcher(
  watchRoot: string,
  usePolling: boolean,
  subscription: AncestorSubscription,
): { release: () => void } {
  let group = ancestorWatchers.get(watchRoot);
  if (!group) {
    const subscriptions = new Set<AncestorSubscription>([subscription]);
    group = {
      watcher: createAncestorWatcher(watchRoot, usePolling, subscriptions),
      ready: false,
      subscriptions,
    };
    ancestorWatchers.set(watchRoot, group);
    observeAncestorWatcher(group);
  } else {
    group.subscriptions.add(subscription);
    if (group.error) {
      const retired = group.watcher;
      group.watcher = createAncestorWatcher(watchRoot, usePolling, group.subscriptions);
      group.error = undefined;
      observeAncestorWatcher(group);
      // Releases retain this group and its subscriptions across native retries.
      void teardownSkillsPathWatcher({ watcher: retired });
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
        void teardownSkillsPathWatcher(current);
      }
    },
  };
}
