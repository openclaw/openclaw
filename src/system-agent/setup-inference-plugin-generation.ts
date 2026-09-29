// Build one fresh plugin runtime generation for setup-owner revalidation.
import type { AgentHarnessPluginSelection } from "../agents/harness/runtime-plugin-load-plan.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { withPluginCache, type PluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";

/** Setup owns fresh package facts without replacing the Gateway's startup generation. */
export function loadSetupInferencePluginGeneration(params: {
  cache: PluginCache;
  config: OpenClawConfig;
  workspaceDir: string;
  selection: AgentHarnessPluginSelection;
  pendingPluginInstalls?: Record<string, PluginInstallRecord>;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
}) {
  // Revalidation must select the probed artifacts: switching a built Gateway
  // owner to source files would report drift even when neither tree changed.
  const preferBuiltPluginArtifacts = getPluginRuntimeLoadContext(
    getPluginRegistryForContext() ?? undefined,
  )?.preferBuiltPluginArtifacts;
  // The install lease may have cached absence before writing the package.
  // This post-mutation owner must capture new facts without retiring that lease's cache.
  return withPluginCache(params.cache, () => {
    const index = params.pendingPluginInstalls
      ? loadInstalledPluginIndex({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
          installRecords: {
            ...loadInstalledPluginIndexInstallRecordsSync(),
            ...params.pendingPluginInstalls,
          },
        })
      : undefined;
    const generation = {
      config: params.config,
      metadataSnapshot: (params.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot)({
        config: params.config,
        env: process.env,
        workspaceDir: params.workspaceDir,
        allowCurrent: false,
        ...(index ? { index } : {}),
      }),
    };
    const pluginRegistry = withPluginRuntimeGenerationScope(generation, () =>
      loadAgentRuntimePluginRegistryHandle({
        config: params.config,
        workspaceDir: params.workspaceDir,
        metadataSnapshot: generation.metadataSnapshot,
        preferBuiltPluginArtifacts,
        selections: [params.selection],
      }),
    );
    if (!pluginRegistry) {
      throw new Error(`Could not load the ${params.selection.runtime} runtime plugin.`);
    }
    return { ...generation, pluginRegistry };
  });
}
