// Rebuilds an exact verified inference owner after a successful live probe.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessPluginSelection } from "../agents/harness/runtime-plugin-load-plan.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-record-reader.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import {
  resolveSystemAgentExecutionRoute,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { parseRef } from "./setup-inference-plan-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type RevalidationDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
};

/** Setup owns fresh package facts without replacing the Gateway's startup generation. */
export function loadSetupInferencePluginGeneration(params: {
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
  return withPluginCache(createPluginCache(), () => {
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

export function withConfiguredHelperRuntime<T>(
  route: SystemAgentConfiguredRoute,
  deps: Pick<RevalidationDeps, "resolvePluginMetadataSnapshot"> | undefined,
  run: () => T,
): T {
  const configuredRuntime =
    route.runner === "embedded" ? route.agentHarnessRuntimeOverride?.trim() : undefined;
  if (!configuredRuntime || configuredRuntime === "auto" || configuredRuntime === "openclaw") {
    return run();
  }
  const generation = loadSetupInferencePluginGeneration({
    config: route.runConfig,
    workspaceDir: resolveAgentWorkspaceDir(route.runConfig, route.agentId, process.env),
    selection: {
      provider: parseRef(route.modelLabel).provider,
      modelId: route.model,
      runtime: configuredRuntime,
      agentId: route.agentId,
    },
    resolvePluginMetadataSnapshot: deps?.resolvePluginMetadataSnapshot,
  });
  return withPluginRuntimeGenerationScope(generation, run);
}

export function resolveLoadedHelperExecutionRoute(
  route: SystemAgentConfiguredRoute,
  deps?: Pick<RevalidationDeps, "resolvePluginMetadataSnapshot">,
): SystemAgentConfiguredRoute {
  const configuredRuntime =
    route.runner === "embedded" ? route.agentHarnessRuntimeOverride?.trim() : undefined;
  if (
    !configuredRuntime ||
    configuredRuntime === "auto" ||
    configuredRuntime === "openclaw" ||
    getRegisteredAgentHarness(configuredRuntime)
  ) {
    return resolveSystemAgentExecutionRoute(route);
  }
  return withConfiguredHelperRuntime(route, deps, () => resolveSystemAgentExecutionRoute(route));
}

export async function revalidateSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  ownerPluginIds?: readonly string[];
  deps: RevalidationDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const configuredRuntime =
    params.route.runner === "embedded"
      ? params.route.agentHarnessRuntimeOverride?.trim()
      : undefined;
  if (configuredRuntime && configuredRuntime !== "auto" && configuredRuntime !== "openclaw") {
    return await withConfiguredHelperRuntime(params.route, params.deps, () => {
      const executionRoute = resolveSystemAgentExecutionRoute(params.route);
      return (
        params.deps.createSystemAgentVerifiedInferenceBinding ??
        createSystemAgentVerifiedInferenceBinding
      )({
        configuredRoute: params.route,
        executionRoute,
        auth: params.auth,
        deps: params.deps,
      });
    });
  }
  const executionRoute = resolveSystemAgentExecutionRoute(params.route);
  const executionHarnessId =
    executionRoute.runner === "embedded"
      ? executionRoute.agentHarnessRuntimeOverride?.trim()
      : undefined;
  const createBinding = () =>
    (
      params.deps.createSystemAgentVerifiedInferenceBinding ??
      createSystemAgentVerifiedInferenceBinding
    )({
      configuredRoute: params.route,
      executionRoute,
      auth: params.auth,
      deps: params.deps,
    });
  if (
    params.ownerPluginIds?.length ||
    (executionRoute.runner === "embedded" &&
      executionHarnessId &&
      executionHarnessId !== "openclaw")
  ) {
    const workspaceDir = resolveAgentWorkspaceDir(
      params.route.runConfig,
      params.route.agentId,
      process.env,
    );
    const generation = loadSetupInferencePluginGeneration({
      config: params.route.runConfig,
      workspaceDir,
      selection: {
        provider: parseRef(params.route.modelLabel).provider,
        modelId: params.route.model,
        ...(params.route.runner === "cli"
          ? { runtime: executionRoute.provider }
          : executionHarnessId
            ? { runtime: executionHarnessId }
            : {}),
        agentId: params.route.agentId,
      },
      resolvePluginMetadataSnapshot: params.deps.resolvePluginMetadataSnapshot,
    });
    return await withPluginRuntimeGenerationScope(generation, createBinding);
  }
  return await createBinding();
}
