import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../loader.js";
import { hasExplicitPluginIdScope } from "../plugin-scope.js";
import type { PluginRegistry } from "../registry.js";
import type { PluginLogger } from "../types.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext } from "./load-context.js";

export function loadPluginMetadataRegistrySnapshot(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  logger?: PluginLogger;
  onlyPluginIds?: string[];
  loadModules?: boolean;
  emitTrustWarnings?: boolean;
}): PluginRegistry {
  const context = resolvePluginRuntimeLoadContext(options);

  return loadOpenClawPlugins(
    buildPluginRuntimeLoadOptions(context, {
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: options?.loadModules,
      ...(options?.emitTrustWarnings !== undefined
        ? { emitTrustWarnings: options.emitTrustWarnings }
        : {}),
      ...(hasExplicitPluginIdScope(options?.onlyPluginIds)
        ? { onlyPluginIds: options?.onlyPluginIds }
        : {}),
    }),
  );
}
