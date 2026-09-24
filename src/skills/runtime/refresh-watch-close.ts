import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { FSWatcher } from "chokidar";

// Retired roots leave the watcher registry before their asynchronous native closes settle.
const pendingWatcherCloses = new Set<Promise<Result<void, unknown>>>();

export function trackSkillsWatcherClose(
  close: () => void | Promise<void>,
): Promise<Result<void, unknown>> {
  const closing = (async (): Promise<Result<void, unknown>> => {
    try {
      await close();
      return ok(undefined);
    } catch (error) {
      return err(error);
    }
  })();
  pendingWatcherCloses.add(closing);
  void closing.then(() => pendingWatcherCloses.delete(closing));
  return closing;
}

export function teardownSkillsPathWatcher(state: {
  watcher: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}): Promise<Result<void, unknown>> {
  const watcher = state.watcher;
  // Chokidar can recover removed paths after close, including from pending reads.
  // Only replacement watchers may admit roots once this instance is retired.
  watcher.add = () => watcher;
  clearTimeout(state.timer);
  return trackSkillsWatcherClose(async () => {
    const wasClosed = watcher.closed;
    let closed: ReturnType<FSWatcher["close"]>;
    try {
      closed = watcher.close();
    } finally {
      if (!wasClosed) {
        // A synchronous close failure can follow listener removal too. Preserve
        // its Result while fencing errors from the dependency's pending scans.
        watcher.on("error", () => {});
      }
    }
    await closed;
  });
}

export async function joinSkillsWatcherCloses(): Promise<void> {
  await Promise.all(pendingWatcherCloses);
}
