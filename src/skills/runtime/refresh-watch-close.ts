import type { FSWatcher } from "chokidar";

// Retired roots leave the watcher registry before their asynchronous native closes settle.
const pendingWatcherCloses = new Set<Promise<void>>();

export function teardownSkillsPathWatcher(state: {
  watcher: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}): Promise<void> {
  const watcher = state.watcher;
  // Chokidar can recover removed paths after close, including from pending reads.
  // Only replacement watchers may admit roots once this instance is retired.
  watcher.add = () => watcher;
  clearTimeout(state.timer);
  const closing = (async () => {
    try {
      const wasClosed = watcher.closed;
      const closed = watcher.close();
      if (!wasClosed) {
        // Chokidar removes listeners before pending scans settle. Their late errors
        // belong to the retired watcher and must not become unhandled events.
        watcher.on("error", () => {});
      }
      await closed;
    } catch {
      // Closing watchers is best effort, including during replacement and shutdown.
    }
  })();
  pendingWatcherCloses.add(closing);
  void closing.then(() => pendingWatcherCloses.delete(closing));
  return closing;
}

export async function joinSkillsWatcherCloses(): Promise<void> {
  await Promise.all(pendingWatcherCloses);
}
