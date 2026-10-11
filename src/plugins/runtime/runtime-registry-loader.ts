// Runtime registry loader assembles process-root plugin runtimes from config metadata.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../activation-context.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
} from "../channel-plugin-ids.js";
import { normalizePluginsConfig } from "../config-state.js";
import { resolveEffectivePluginIds } from "../effective-plugin-ids.js";
import { collectConfiguredMemoryEmbeddingProviderIds } from "../gateway-startup-plugin-ids.js";
import { createInstalledPluginIndexScopeLookup } from "../installed-plugin-index-scope-lookup.js";
import { loadAndActivateRootPluginRegistry } from "../loader.js";
import { hasNonEmptyPluginIdScope } from "../plugin-scope.js";
import { buildPluginRuntimeLoadOptions } from "./load-context.js";
import { resolvePluginRuntimeLoadContext } from "./load-context.resolve.js";

export type PluginRegistryScope =
  | "configured-channels"
  | "channels"
  | "memory"
  | "sandbox-backends"
  | "all";

// Core-owned backends must keep their registry ownership if a plugin reuses an id.
const CORE_SANDBOX_BACKEND_IDS = new Set(["docker", "podman", "ssh"]);

function resolveMemoryPluginIds(
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>,
): string[] {
  const configuredProviderIds = [
    ...collectConfiguredMemoryEmbeddingProviderIds(context.activationSourceConfig),
  ];
  const pluginIds = new Set<string>();
  if (context.metadataSnapshot) {
    createInstalledPluginIndexScopeLookup(
      context.metadataSnapshot.index,
    ).addProviderContributionOwners(pluginIds, configuredProviderIds);
  } else {
    for (const providerId of configuredProviderIds) {
      pluginIds.add(providerId);
    }
  }
  const memoryPluginId = normalizePluginsConfig(context.config.plugins).slots.memory?.trim();
  if (memoryPluginId) {
    pluginIds.add(memoryPluginId);
  }
  return [...pluginIds].toSorted();
}

function resolveSandboxBackendPluginIds(
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>,
  persistedBackendIds: readonly string[] = [],
): string[] {
  if (!context.metadataSnapshot) {
    return [];
  }
  const agents = context.activationSourceConfig.agents;
  const configuredBackendIds = [
    agents?.defaults?.sandbox?.backend,
    ...listAgentEntries(context.activationSourceConfig).map((agent) => agent.sandbox?.backend),
    ...persistedBackendIds,
  ];
  const lookup = createInstalledPluginIndexScopeLookup(context.metadataSnapshot.index);
  const pluginIds = new Set<string>();
  for (const backendId of configuredBackendIds) {
    const normalizedBackendId = normalizeOptionalLowercaseString(backendId);
    if (
      !normalizedBackendId ||
      CORE_SANDBOX_BACKEND_IDS.has(normalizedBackendId) ||
      !lookup.hasInstalledPluginIds([normalizedBackendId])
    ) {
      continue;
    }
    // Backend ids have no manifest ownership contract; only an exact installed plugin id is safe.
    pluginIds.add(lookup.normalizePluginId(normalizedBackendId));
  }
  return [...pluginIds].toSorted();
}

export async function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  persistedSandboxBackendIds?: readonly string[];
}): Promise<void> {
  const scope = options?.scope ?? "all";
  const context = resolvePluginRuntimeLoadContext(options);
  let pluginIds: string[];
  switch (scope) {
    case "configured-channels":
      pluginIds = resolveConfiguredChannelPluginIds({
        config: context.config,
        activationSourceConfig: context.activationSourceConfig,
        workspaceDir: context.workspaceDir,
        env: context.env,
      });
      break;
    case "channels":
      pluginIds = resolveChannelPluginIds({
        config: context.config,
        workspaceDir: context.workspaceDir,
        env: context.env,
      });
      break;
    case "memory":
      // Memory CLI commands must use the same backend and embedding adapters as
      // Gateway, without activating unrelated explicitly enabled plugins.
      pluginIds = resolveMemoryPluginIds(context);
      break;
    case "sandbox-backends":
      pluginIds = resolveSandboxBackendPluginIds(context, options?.persistedSandboxBackendIds);
      break;
    default:
      pluginIds = resolveEffectivePluginIds({
        config: context.rawConfig,
        workspaceDir: context.workspaceDir,
        env: context.env,
      });
  }
  const activateConfigured = scope === "configured-channels" && pluginIds.length > 0;
  const config = activateConfigured
    ? (withActivatedPluginIds({ config: context.config, pluginIds }) ?? context.config)
    : context.config;
  const activationSourceConfig = activateConfigured
    ? (withActivatedPluginIds({
        config: context.activationSourceConfig,
        pluginIds,
      }) ?? context.activationSourceConfig)
    : context.activationSourceConfig;
  await loadAndActivateRootPluginRegistry(
    buildPluginRuntimeLoadOptions(
      { ...context, config, activationSourceConfig },
      {
        throwOnLoadError: true,
        ...(scope === "configured-channels" ||
        scope === "memory" ||
        scope === "sandbox-backends" ||
        scope === "all" ||
        hasNonEmptyPluginIdScope(pluginIds)
          ? { onlyPluginIds: pluginIds }
          : {}),
      },
    ),
  );
}
