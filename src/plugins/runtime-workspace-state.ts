// Shares plugin runtime workspace state across module reloads.
import { AsyncLocalStorage } from "node:async_hooks";

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type GlobalRegistryWorkspaceState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: {
    workspaceDir?: string | null;
  };
};

type PinnedWorkspaceDirStore = { workspaceDir: string | undefined };

// AsyncLocalStorage pins the active plugin-registry workspace dir for the
// duration of a row-building batch (e.g. sessions.list). Without it, per-row
// metadata lookups read a process-global that concurrent agent-turns/crons
// mutate between async yields, defeating the metadata-snapshot memo and
// forcing an O(rows) full plugin-metadata scan (issue #90814, residual of
// #76562). The pin is async-context-scoped, so other concurrent contexts
// still observe the live global.
const pinnedWorkspaceDirStorage = new AsyncLocalStorage<PinnedWorkspaceDirStore>();

function readGlobalWorkspaceDir(): string | undefined {
  return (
    (globalThis as GlobalRegistryWorkspaceState)[PLUGIN_REGISTRY_STATE]?.workspaceDir ?? undefined
  );
}

/** Reads the active plugin registry workspace directory from global runtime state. */
export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  const pinned = pinnedWorkspaceDirStorage.getStore();
  if (pinned) return pinned.workspaceDir;
  return readGlobalWorkspaceDir();
}

/**
 * Pins the active plugin-registry workspace dir for the duration of `fn` so
 * per-row metadata lookups within one async batch see a stable value, immune
 * to concurrent global mutation across `await` yields. Nested calls reuse the
 * outer pin so we do not re-snapshot mid-batch.
 */
export function withPinnedActivePluginRegistryWorkspaceDir<T>(fn: () => T): T {
  if (pinnedWorkspaceDirStorage.getStore()) return fn();
  const workspaceDir = readGlobalWorkspaceDir();
  return pinnedWorkspaceDirStorage.run({ workspaceDir }, fn);
}
