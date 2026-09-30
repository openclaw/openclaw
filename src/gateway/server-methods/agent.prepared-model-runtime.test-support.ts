import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createAgentTestPreparedModelRuntime(resolveConfig: () => OpenClawConfig) {
  // Direct handler tests bypass Gateway startup, which publishes this generation
  // before admitting agent RPCs.
  const pluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: {},
    configuredCatalogEntries: [],
    inlineProviderModels: [],
  };
  return {
    acquireAgentRunPreparedModelRuntime: vi.fn(async () => ({
      [Symbol.asyncDispose]: vi.fn(async () => {}),
      snapshot: {},
      pluginGeneration,
    })),
    loadPublishedGatewayReplyDispatchRuntime: async ({ agentId }: { agentId: string }) => ({
      agentId,
      agentDir: "/tmp/agent",
      config: resolveConfig(),
      pluginGeneration,
      workspaceDir: "/tmp/workspace",
    }),
  };
}
