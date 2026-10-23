import { vi } from "vitest";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLeaseOptions,
} from "../../agents/prepared-model-runtime.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";

export function createCronPreparedModelRuntimeFixture(
  input: PreparedModelRuntimeInput,
  options: PreparedModelRuntimeLeaseOptions | undefined,
  registry: PluginRegistry,
) {
  const metadata =
    options?.pluginGeneration?.pluginMetadataSnapshot ??
    options?.pluginMetadataSnapshot ??
    createPluginMetadataSnapshotFixture();
  return {
    snapshot: {
      ...input,
      metadataSnapshot: metadata,
      pluginRegistry: registry,
      modelCatalog: { entries: [], routeVariants: [] },
    },
    pluginGeneration: {
      ...options?.pluginGeneration,
      pluginMetadataSnapshot: metadata,
      pluginRegistry: registry,
    },
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}
