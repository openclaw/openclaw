import type { Result } from "@openclaw/normalization-core/result";
import chokidar, { type FSWatcher, type FSWatcherEventMap } from "chokidar";
import { createNativeSkillsContentWatcher } from "./refresh-content-native.js";
import { teardownSkillsPathWatcher } from "./refresh-watch-close.js";
import type { createSkillsWatchPathFilter } from "./refresh-watch-path.js";
import type { WatchTarget } from "./refresh-watch-targets.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";

export function shouldUseNativeSkillsWatcher(usePolling: boolean): boolean {
  // Darwin restarts a shared FSEvent stream when native handles retire. Keep
  // Chokidar's pooled generations there until Skills can preserve that handoff.
  return (
    !usePolling &&
    !process.versions.bun &&
    (process.platform === "linux" || process.platform === "win32")
  );
}

function adaptChokidarSkillsWatcher(watcher: FSWatcher): SkillsDirectoryWatcher {
  let closing: Promise<Result<void, unknown>> | undefined;
  return {
    get closed() {
      return watcher.closed;
    },
    get directories() {
      return new Set(Object.keys(watcher.getWatched()));
    },
    // Stock Chokidar supplies canonical entry deltas through its existing events.
    on: <Event extends keyof FSWatcherEventMap>(
      event: Event | "dirty",
      listener: Parameters<typeof watcher.on<Event>>[1],
    ) => (event === "dirty" ? undefined : watcher.on<Event>(event, listener)),
    close: () => (closing ??= teardownSkillsPathWatcher({ watcher })),
  };
}

export function createSkillsContentWatchFactory(
  runInContext: (create: () => SkillsDirectoryWatcher) => SkillsDirectoryWatcher,
) {
  return (
    target: Pick<WatchTarget, "path" | "depth">,
    usePolling: boolean,
    ignored: ReturnType<typeof createSkillsWatchPathFilter>["ignored"],
    stabilityThreshold: number,
  ): SkillsDirectoryWatcher =>
    runInContext(() =>
      shouldUseNativeSkillsWatcher(usePolling)
        ? createNativeSkillsContentWatcher(target.path, {
            depth: target.depth + 1,
            ignored,
          })
        : adaptChokidarSkillsWatcher(
            chokidar.watch(target.path, {
              ignoreInitial: true,
              followSymlinks: false,
              usePolling,
              // Identity metadata sits one level below the deepest admitted skill.
              depth: target.depth + 1,
              awaitWriteFinish: {
                stabilityThreshold,
                pollInterval: 100,
              },
              ignored,
            }),
          ),
    );
}
