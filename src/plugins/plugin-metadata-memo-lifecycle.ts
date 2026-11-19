// Registration stays independent of Gateway capture custody so read-only workers
// can own metadata memos without initializing the Gateway's source captures.
const pluginMetadataProcessMemoClears = new Map<() => void, "process" | "operation">();

/** Registers a metadata clear hook with the lifetime of its facts. */
export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
  options: { owner: "process" | "operation" } = { owner: "process" },
): void {
  pluginMetadataProcessMemoClears.set(clearProcessMemo, options.owner);
}

export function clearPluginMetadataMemos(owner: "process" | "operation"): void {
  for (const [clearMemo, memoOwner] of pluginMetadataProcessMemoClears) {
    if (memoOwner === owner) {
      clearMemo();
    }
  }
}
