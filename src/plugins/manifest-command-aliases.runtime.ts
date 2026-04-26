import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
  type PluginManifestCommandAliasRecord,
} from "./manifest-command-aliases.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { loadPluginRegistrySnapshot } from "./plugin-registry.js";

export function resolveManifestCommandAliasOwner(params: {
  command: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined {
  const registry =
    params.registry ??
    (() => {
      const index = loadPluginRegistrySnapshot({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      });
      return loadPluginManifestRegistryForInstalledIndex({
        index,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        includeDisabled: true,
      });
    })();
  return resolveManifestCommandAliasOwnerInRegistry({
    command: params.command,
    registry,
  });
}
