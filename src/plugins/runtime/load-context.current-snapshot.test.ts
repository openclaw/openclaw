import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "../current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "../current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../installed-plugin-index-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { resolvePluginRuntimeLoadContext } from "./load-context.resolve.js";

const resolvePluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: resolvePluginMetadataSnapshotMock,
}));

function createSnapshot(params: {
  config: OpenClawConfig;
  workspaceDir: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const snapshot = createPluginMetadataSnapshotFixture();
  const index = { ...snapshot.index, policyHash, generatedAtMs: 1 };
  return {
    ...snapshot,
    policyHash,
    workspaceDir: params.workspaceDir,
    index,
    registryIndex: index,
    normalizePluginId: (pluginId) => pluginId,
    discovery: { candidates: [], diagnostics: [] },
  };
}

afterEach(() => {
  resolvePluginMetadataSnapshotMock.mockReset();
  clearPluginMetadataLifecycleCaches();
});

it("keeps explicit operation metadata from replacing the Gateway startup inventory", () => {
  const lifecycle = {
    config: { plugins: { allow: ["lifecycle"] } },
    workspaceDir: "/workspace/lifecycle",
  };
  const operation = {
    config: { plugins: { allow: ["operation"] } },
    workspaceDir: "/workspace/operation",
  };
  const lifecycleSnapshot = createSnapshot(lifecycle);
  const operationSnapshot = createSnapshot(operation);
  setGatewayPluginMetadataSnapshot(lifecycleSnapshot, lifecycle);
  const context = resolvePluginRuntimeLoadContext({
    ...operation,
    metadataSnapshot: operationSnapshot,
  });

  expect(context.metadataSnapshot).toBe(operationSnapshot);
  expect(resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
  expect(getGatewayPluginMetadataSnapshot()).toBe(lifecycleSnapshot);
  expect(getCurrentPluginMetadataSnapshot(lifecycle)).toBe(lifecycleSnapshot);
  expect(getCurrentPluginMetadataSnapshot(operation)).toBe(lifecycleSnapshot);
});
