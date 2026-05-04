import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
  type PluginManifestCommandAliasRecord,
} from "./manifest-command-aliases.js";
import { loadManifestMetadataRegistry } from "./manifest-contract-eligibility.js";

export function resolveManifestCommandAliasOwner(params: {
  command: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined {
  const registry =
    params.registry ??
    loadManifestMetadataRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).manifestRegistry;
  return resolveManifestCommandAliasOwnerInRegistry({
    command: params.command,
    registry,
  });
}

export function resolveManifestToolOwner(params: {
  toolName: string | undefined;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const normalized = normalizeOptionalLowercaseString(params.toolName);
  if (!normalized) {
    return undefined;
  }
  const { manifestRegistry } = loadManifestMetadataRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  for (const plugin of manifestRegistry.plugins) {
    const toolNames = plugin.contracts?.tools;
    if (
      Array.isArray(toolNames) &&
      toolNames.some((t) => normalizeOptionalLowercaseString(t) === normalized)
    ) {
      return plugin.id;
    }
  }
  return undefined;
}
