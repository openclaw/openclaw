// Shares plugin runtime workspace state across module reloads.
import { AsyncLocalStorage } from "node:async_hooks";

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type GlobalRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

// Pins the active workspace dir for the duration of a batch (e.g. gateway
// sessions.list, which resolves plugin metadata once per row). The underlying
// global is mutated by concurrent agent-turns/crons via setActivePluginRegistry;
// without a pin, a batch that yields the event loop between rows reads a
// different workspaceDir each row, so the plugin-metadata-snapshot memo key
// changes every row and never hits — turning one list into O(rows) full scans.
// AsyncLocalStorage scopes the pin to the batch's async context only, so other
// concurrent contexts still observe the live global.
const pinnedWorkspaceDirStorage = new AsyncLocalStorage<{ workspaceDir: string | undefined }>();

/** Reads the active plugin registry workspace directory from global runtime state. */
export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  const pinned = pinnedWorkspaceDirStorage.getStore();
  if (pinned) {
    return pinned.workspaceDir;
  }
  return (
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined
  );
}

/**
 * Runs `fn` with the active plugin registry workspace dir pinned to its current
 * value, so reads inside `fn` (and its awaited continuations) are stable even if
 * concurrent work mutates the global. Nested calls reuse the outer pin.
 */
export function withPinnedActivePluginRegistryWorkspaceDir<T>(fn: () => T): T {
  if (pinnedWorkspaceDirStorage.getStore()) {
    return fn();
  }
  const workspaceDir =
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined;
  return pinnedWorkspaceDirStorage.run({ workspaceDir }, fn);
}
