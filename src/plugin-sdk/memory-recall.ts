import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type { OpenKeyedStoreOptions, PluginStateKeyedStore } from "./plugin-state-runtime.js";

/** Interactive recall after final tool selection or accepted prompt injection, never ingestion. */
export type MemoryRecallParams = {
  config: OpenClawConfig;
  workspaceDir: string;
  query: string;
  results: MemorySearchResult[];
  /** Host-provided identities; a session ID is not a run ID. */
  sessionKey: string;
  runId: string;
  /** Preserve the tool/hook invocation's live authority across awaited reads. */
  assertActive: () => void;
};

type RecallModule = {
  configureMemoryCoreDreamingState: (
    open: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  recordMemoryRecall: (
    params: MemoryRecallParams,
    shouldRecordRecall: (result: MemorySearchResult) => boolean,
  ) => Promise<void>;
};

async function loadRecorder(): Promise<RecallModule> {
  const [{ loadBundledPluginPublicSurfaceModuleSyncCore }, { createPluginStateKeyedStore }] =
    await Promise.all([
      import("./facade-loader.js"),
      import("../plugin-state/plugin-state-store.js"),
    ]);
  const module = loadBundledPluginPublicSurfaceModuleSyncCore<RecallModule>({
    dirName: "memory-core",
    artifactBasename: "runtime-api.js",
  });
  module.configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStore<T>("memory-core", options),
  );
  return module;
}

/** Record grounded surfaced recalls through memory-core, with shared per-run deduplication. */
export async function recordMemoryRecall(params: MemoryRecallParams): Promise<void> {
  params.assertActive();
  if (!params.runId.trim() || !params.sessionKey.trim()) {
    return;
  }
  const { getPluginRunContext, setPluginRunContext } =
    await import("../plugins/host-hook-runtime.js");
  const context = { pluginId: "memory-core", get: { runId: params.runId, namespace: "recall" } };
  const readKeys = (): string[] => {
    const value = getPluginRunContext(context);
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  };
  const writeKeys = (keys: string[]) =>
    setPluginRunContext({
      pluginId: context.pluginId,
      patch: { ...context.get, value: keys },
    });
  // The native owner invokes this claim inside its workspace mutation lock.
  // Keep claims after ambiguous failures: a store commit can precede an event failure.
  await (
    await loadRecorder()
  ).recordMemoryRecall(params, (result) => {
    params.assertActive();
    const keys = new Set(readKeys());
    const key = JSON.stringify([
      params.workspaceDir,
      params.sessionKey,
      result.path,
      result.startLine,
    ]);
    const isNewRecall = !keys.has(key);
    keys.add(key);
    // Even metadata-only observations require an open host run.
    if (!writeKeys([...keys])) {
      throw new Error("Memory recall run is closed");
    }
    return isNewRecall;
  });
}
