// Metadata registry loader builds plugin metadata registries without activating runtime barrels.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginRegistryHandleAsync } from "../loader.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import { hasExplicitPluginIdScope } from "../plugin-scope.js";
import type { PluginRegistry } from "../registry.js";
import type { PluginLogger } from "../types.js";
import { buildPluginRuntimeLoadOptions, type PluginRuntimeLoadContext } from "./load-context.js";
import { resolvePluginRuntimeLoadContextAsync } from "./load-context.resolve.js";

/** Loads a non-activated plugin metadata registry snapshot for validation/status callers. */
export async function loadPluginMetadataRegistrySnapshotAsync(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
  runtimeContext?: PluginRuntimeLoadContext;
}): Promise<PluginRegistry> {
  const context = options?.runtimeContext ?? (await resolvePluginRuntimeLoadContextAsync(options));

  return await loadPluginRegistryHandleAsync(
    buildPluginRuntimeLoadOptions(context, {
      ...(options?.config !== undefined ? { config: options.config } : {}),
      ...(options?.activationSourceConfig !== undefined
        ? { activationSourceConfig: options.activationSourceConfig }
        : {}),
      ...(options?.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.logger !== undefined ? { logger: options.logger } : {}),
      throwOnLoadError: options?.throwOnLoadError ?? true,
      cache: false,
      mode: "validate",
      loadModules: options?.loadModules,
      ...(hasExplicitPluginIdScope(options?.onlyPluginIds)
        ? { onlyPluginIds: options?.onlyPluginIds }
        : {}),
      ...(options?.manifestRegistry ? { manifestRegistry: options.manifestRegistry } : {}),
    }),
  );
}
