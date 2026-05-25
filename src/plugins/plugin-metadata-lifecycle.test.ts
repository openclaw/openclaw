import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
} from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

let disposeMemoClearer: (() => void) | undefined;

afterEach(() => {
  disposeMemoClearer?.();
  disposeMemoClearer = undefined;
  clearCurrentPluginMetadataSnapshotState();
});

function createSnapshot(): PluginMetadataSnapshot {
  return {
    policyHash: "test",
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
  } as PluginMetadataSnapshot;
}

describe("plugin metadata lifecycle caches", () => {
  it("clears the current snapshot and fans out to the registered process memo clearer", () => {
    const clearer = vi.fn();
    setCurrentPluginMetadataSnapshot(createSnapshot());
    disposeMemoClearer = registerPluginMetadataProcessMemoLifecycleClear(clearer);

    clearPluginMetadataLifecycleCaches();

    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
    expect(clearer).toHaveBeenCalledTimes(1);
  });

  it("stops calling the registered process memo clearer after disposal", () => {
    const clearer = vi.fn();
    disposeMemoClearer = registerPluginMetadataProcessMemoLifecycleClear(clearer);
    disposeMemoClearer();
    disposeMemoClearer = undefined;

    clearPluginMetadataLifecycleCaches();

    expect(clearer).not.toHaveBeenCalled();
  });

  it("does not let an old disposer unregister a newer process memo clearer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = registerPluginMetadataProcessMemoLifecycleClear(first);
    disposeMemoClearer = registerPluginMetadataProcessMemoLifecycleClear(second);

    disposeFirst();
    clearPluginMetadataLifecycleCaches();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
