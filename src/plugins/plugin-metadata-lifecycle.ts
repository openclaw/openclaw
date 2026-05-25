import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";

let clearPluginMetadataProcessMemo: (() => void) | undefined;

export function registerPluginMetadataProcessMemoLifecycleClear(clearer: () => void): () => void {
  clearPluginMetadataProcessMemo = clearer;
  return () => {
    if (clearPluginMetadataProcessMemo === clearer) {
      clearPluginMetadataProcessMemo = undefined;
    }
  };
}

export function clearPluginMetadataLifecycleCaches(): void {
  clearCurrentPluginMetadataSnapshotState();
  clearPluginMetadataProcessMemo?.();
}
