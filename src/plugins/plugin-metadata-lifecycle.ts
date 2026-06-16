/** Coordinates plugin metadata snapshot and process memo cache lifecycle resets. */
import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";

const pluginMetadataProcessMemoClears = new Set<() => void>();

/** Registers a process-local plugin metadata memo clear hook. Returns a disposer that unregisters this exact hook. */
export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): () => void {
  pluginMetadataProcessMemoClears.add(clearProcessMemo);
  return () => {
    pluginMetadataProcessMemoClears.delete(clearProcessMemo);
  };
}

/** Clears plugin metadata snapshots and registered process memo caches. */
export function clearPluginMetadataLifecycleCaches(): void {
  clearCurrentPluginMetadataSnapshotState();
  for (const clearProcessMemo of pluginMetadataProcessMemoClears) {
    clearProcessMemo();
  }
}
