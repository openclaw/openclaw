import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
  type PluginManifestCommandAliasRecord,
  type PluginManifestToolOwnerRecord,
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
  registry?: PluginManifestCommandAliasRegistry;
}): PluginManifestToolOwnerRecord | undefined {
  const registry =
    params.registry ??
    loadManifestMetadataRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
    }).manifestRegistry;
  return resolveManifestToolOwnerInRegistry({
    toolName: params.toolName,
    registry,
  });
}
