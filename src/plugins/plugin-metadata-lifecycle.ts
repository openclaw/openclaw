import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";

const pluginMetadataProcessMemoClears = new Set<() => void>();

export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): () => void {
  pluginMetadataProcessMemoClears.add(clearProcessMemo);
  return () => {
    pluginMetadataProcessMemoClears.delete(clearProcessMemo);
  };
}

export function clearPluginMetadataLifecycleCaches(): void {
  clearCurrentPluginMetadataSnapshotState();
  for (const clearProcessMemo of pluginMetadataProcessMemoClears) {
    clearProcessMemo();
  }
}
