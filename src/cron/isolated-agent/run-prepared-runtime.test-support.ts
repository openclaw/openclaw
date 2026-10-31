import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLeaseOptions,
} from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";

type CatalogOwnerInput = {
  agentId?: string;
  agentDir?: string;
  config: OpenClawConfig;
  workspaceDir?: string;
};

export async function createCronModelCatalogOwnerFixture(
  params: CatalogOwnerInput,
  deps: {
    resolveAgentDir: (config: OpenClawConfig, agentId: string) => string;
    resolveAgentWorkspaceDir: (config: OpenClawConfig, agentId: string) => string;
    loadModelCatalog: (params: CatalogOwnerInput) => Promise<ModelCatalogEntry[]>;
  },
) {
  const agentId = params.agentId ?? "default";
  return {
    agentId,
    // Capture and execution must address the same fixture credential owner.
    agentDir: params.agentDir ?? deps.resolveAgentDir(params.config, agentId),
    workspaceDir: params.workspaceDir ?? deps.resolveAgentWorkspaceDir(params.config, agentId),
    config: params.config,
    modelCatalog: { entries: await deps.loadModelCatalog(params), routeVariants: [] },
  };
}

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
    run: <T>(run: () => T): T => run(),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}
