// Pins the active plugin-registry workspace dir for the duration of an async
// scope so reads of the process-global workspace dir stay stable even when
// concurrent agent-turns or crons mutate it via setActivePluginRegistry.
//
// Without a pin, a batch that yields the event loop between rows (e.g. gateway
// sessions.list) reads a different workspaceDir each row, so the
// plugin-metadata-snapshot memo key changes every row and never hits, turning
// one list into O(rows) full metadata scans (~100 ms each).
//
// AsyncLocalStorage scopes the pin to the current async context only; other
// concurrent contexts still observe the live global.
import { AsyncLocalStorage } from "node:async_hooks";

const pinnedWorkspaceDir = new AsyncLocalStorage<string | undefined>();

/** Reads the workspace dir pinned to the current async context, if any. */
export function getPinnedWorkspaceDir(): string | undefined {
  return pinnedWorkspaceDir.getStore();
}

/**
 * Runs `fn` with the active plugin-registry workspace dir pinned to the given
 * value. Nested calls reuse the outer pin so a mid-batch registry mutation
 * inside a pin scope does not change what the rest of the batch observes.
 */
export function runWithPinnedWorkspaceDir<T>(
  workspaceDir: string | undefined,
  fn: () => T,
): T {
  if (pinnedWorkspaceDir.getStore() !== undefined) {
    return fn();
  }
  return pinnedWorkspaceDir.run(workspaceDir, fn);
}
