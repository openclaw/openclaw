import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { FSWatcherEventMap } from "chokidar";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

export function useSkillsWatcherFixture() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      const { closeSkillsWatchers } = await import("./refresh.js");
      await closeSkillsWatchers(true);
      cleanup();
    }),
  );
  let fixtureRoot: string;
  let workspaceDir: string;

  async function createFixtureDirectory(relativePath: string): Promise<string> {
    const directory = path.join(fixtureRoot, relativePath);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  beforeEach(async () => {
    fixtureRoot = tempDirs.make("openclaw-watch-fixture-");
    workspaceDir = await createFixtureDirectory("workspace");
    await createFixtureDirectory("workspace/skills");
  });

  return {
    createFixtureDirectory,
    get workspaceDir() {
      return workspaceDir;
    },
  };
}

type WatchEvent = keyof FSWatcherEventMap;
type WatchCallback = (...args: unknown[]) => void;
type WatchOptions = {
  depth: number;
  followSymlinks: boolean;
  usePolling: boolean;
  ignored: (
    watchPath: string,
    stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  ) => boolean;
};

function createMockWatcher() {
  const events = new EventEmitter();
  const watcher = {
    closed: false,
    on: vi.fn((event: WatchEvent, callback: WatchCallback) => {
      events.on(event, callback);
      return watcher;
    }),
    close: vi.fn(async () => {
      if (watcher.closed) {
        return;
      }
      watcher.closed = true;
      events.removeAllListeners();
    }),
    emit: (event: WatchEvent, ...args: unknown[]) => {
      events.emit(event, ...args);
    },
  };
  return watcher;
}

export function createSkillsWatcherMock() {
  const createdWatchers: Array<ReturnType<typeof createMockWatcher>> = [];
  const watchMock = vi.fn((_watchRoot: string, _options: WatchOptions) => {
    const watcher = createMockWatcher();
    createdWatchers.push(watcher);
    return watcher;
  });
  const nativeWatchMock = (watchRoot: string, ignored: WatchOptions["ignored"]) =>
    watchMock(watchRoot, { depth: 0, followSymlinks: false, usePolling: false, ignored });
  function watchForSkillRoot(root: string) {
    // Existing roots have their own recursive watcher. Missing roots share a
    // shallow ancestor whose public traversal filter admits the logical path.
    const normalizedRoot = root.replaceAll("\\", "/");
    let index = watchMock.mock.calls.findLastIndex(
      ([watchRoot, options], candidate) =>
        watchRoot === normalizedRoot && options.depth > 0 && !createdWatchers[candidate]?.closed,
    );
    if (index < 0) {
      let closest = -1;
      for (const [candidate, [watchRoot, options]] of watchMock.mock.calls.entries()) {
        if (
          !createdWatchers[candidate]?.closed &&
          options.depth === 0 &&
          normalizedRoot.startsWith(watchRoot.endsWith("/") ? watchRoot : `${watchRoot}/`) &&
          !options.ignored(path.join(root, "SKILL.md")) &&
          watchRoot.length >= closest
        ) {
          index = candidate;
          closest = watchRoot.length;
        }
      }
    }
    expect(index, `watch subscription for ${root}`).toBeGreaterThanOrEqual(0);
    const [watchRoot, options] = watchMock.mock.calls[index]!;
    return { watchRoot, options, watcher: createdWatchers[index]! };
  }

  return { createdWatchers, watchMock, nativeWatchMock, watchForSkillRoot };
}
