// Runtime registry loader assembles activated plugin runtimes from config and registry metadata.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../activation-context.js";
import {
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "../active-runtime-registry.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../channel-plugin-ids.js";
import { resolveEffectivePluginIds } from "../effective-plugin-ids.js";
import { initializeGlobalHookRunner } from "../hook-runner-global.js";
import { loadOpenClawPlugins } from "../loader.js";
import {
  hasExplicitPluginIdScope,
  hasNonEmptyPluginIdScope,
  normalizePluginIdScope,
} from "../plugin-scope.js";
import { mergeMissingPluginRegistryInto } from "../registry-scoped-merge.js";
import type { PluginRegistry } from "../registry-types.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryWorkspaceDir,
  getActivePluginRuntimeSubagentMode,
  setActivePluginRegistry,
} from "../runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  resolvePluginRuntimeLoadContext,
} from "./load-context.js";

let pluginRegistryLoaded: "none" | "configured-channels" | "channels" | "all" = "none";

export type PluginRegistryScope = "configured-channels" | "channels" | "all";

function scopeRank(scope: typeof pluginRegistryLoaded): number {
  switch (scope) {
    case "none":
      return 0;
    case "configured-channels":
      return 1;
    case "channels":
      return 2;
    case "all":
      return 3;
  }
  throw new Error("Unsupported plugin registry scope");
}

function activeRegistrySatisfiesScope(
  scope: PluginRegistryScope,
  active: ReturnType<typeof getActivePluginRegistry>,
  expectedChannelPluginIds: readonly string[],
  requestedPluginIds: readonly string[] | undefined,
  requestedWorkspaceDir: string | undefined,
): boolean {
  if (!active) {
    return false;
  }
  if (requestedPluginIds !== undefined) {
    const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
    if (requestedWorkspaceDir !== undefined && activeWorkspaceDir !== requestedWorkspaceDir) {
      return false;
    }
    return registryContainsRuntimePluginIds(active, requestedPluginIds);
  }
  const activeChannelPluginIds = new Set(active.channels.map((entry) => entry.plugin.id));
  switch (scope) {
    case "configured-channels":
    case "channels":
      return (
        active.channels.length > 0 &&
        expectedChannelPluginIds.every((pluginId) => activeChannelPluginIds.has(pluginId))
      );
    case "all":
      return false;
  }
  throw new Error("Unsupported plugin registry scope");
}

function shouldForwardChannelScope(params: {
  scope: PluginRegistryScope;
  scopedLoad: boolean;
}): boolean {
  return !params.scopedLoad && params.scope === "configured-channels";
}

function resolveScopePluginIds(params: {
  scope: PluginRegistryScope;
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
}): string[] {
  switch (params.scope) {
    case "configured-channels":
      return resolveConfiguredChannelPluginIds({
        config: params.context.config,
        activationSourceConfig: params.context.activationSourceConfig,
        workspaceDir: params.context.workspaceDir,
        env: params.context.env,
      });
    case "channels":
      return resolveChannelPluginIds({
        config: params.context.config,
        workspaceDir: params.context.workspaceDir,
        env: params.context.env,
      });
    case "all":
      return resolveEffectivePluginIds({
        config: params.context.rawConfig,
        workspaceDir: params.context.workspaceDir,
        env: params.context.env,
      });
  }
  const unreachableScope: never = params.scope;
  return unreachableScope;
}

function resolveOrLoadRuntimePluginRegistry(
  loadOptions: NonNullable<Parameters<typeof loadOpenClawPlugins>[0]>,
): void {
  if (
    !getLoadedRuntimePluginRegistry({
      env: loadOptions.env,
      loadOptions,
      workspaceDir: loadOptions.workspaceDir,
      requiredPluginIds: loadOptions.onlyPluginIds,
    })
  ) {
    loadOpenClawPlugins(loadOptions);
  }
}

export function ensurePluginRegistryLoaded(options?: {
  scope?: PluginRegistryScope;
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  onlyChannelIds?: string[];
}): void {
  const scope = options?.scope ?? "all";
  const requestedPluginIdsFromOptions = normalizePluginIdScope(options?.onlyPluginIds);
  const requestedChannelIds = normalizePluginIdScope(options?.onlyChannelIds);
  const context = resolvePluginRuntimeLoadContext(options);
  const requestedChannelOwnerPluginIds =
    requestedChannelIds === undefined
      ? undefined
      : resolveDiscoverableScopedChannelPluginIds({
          config: context.config,
          activationSourceConfig: context.activationSourceConfig,
          channelIds: requestedChannelIds,
          workspaceDir: context.workspaceDir,
          env: context.env,
        });
  const requestedPluginIds =
    requestedChannelOwnerPluginIds === undefined
      ? requestedPluginIdsFromOptions
      : normalizePluginIdScope([
          ...(requestedPluginIdsFromOptions ?? []),
          ...requestedChannelOwnerPluginIds,
        ]);
  const scopedLoad = hasExplicitPluginIdScope(requestedPluginIds);
  const expectedPluginIds = scopedLoad
    ? (requestedPluginIds ?? [])
    : resolveScopePluginIds({ scope, context });
  const active = getActivePluginRegistry();
  const requestedPluginIdsForScope =
    scope === "all" && expectedPluginIds.length === 0 ? expectedPluginIds : undefined;
  if (
    !scopedLoad &&
    scopeRank(pluginRegistryLoaded) >= scopeRank(scope) &&
    activeRegistrySatisfiesScope(
      scope,
      active,
      expectedPluginIds,
      requestedPluginIdsForScope,
      context.workspaceDir,
    )
  ) {
    return;
  }
  if (
    (pluginRegistryLoaded === "none" || scopedLoad) &&
    activeRegistrySatisfiesScope(
      scope,
      active,
      expectedPluginIds,
      requestedPluginIds,
      context.workspaceDir,
    )
  ) {
    if (!scopedLoad) {
      pluginRegistryLoaded = scope;
    }
    return;
  }
  const scopedConfig =
    scope === "configured-channels" &&
    expectedPluginIds.length > 0 &&
    (!scopedLoad || requestedChannelOwnerPluginIds !== undefined)
      ? (withActivatedPluginIds({
          config: context.config,
          pluginIds: expectedPluginIds,
        }) ?? context.config)
      : context.config;
  const scopedActivationSourceConfig =
    scope === "configured-channels" &&
    expectedPluginIds.length > 0 &&
    (!scopedLoad || requestedChannelOwnerPluginIds !== undefined)
      ? (withActivatedPluginIds({
          config: context.activationSourceConfig,
          pluginIds: expectedPluginIds,
        }) ?? context.activationSourceConfig)
      : context.activationSourceConfig;
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      ...context,
      config: scopedConfig,
      activationSourceConfig: scopedActivationSourceConfig,
    },
    {
      throwOnLoadError: true,
      ...(hasExplicitPluginIdScope(requestedPluginIds) ||
      shouldForwardChannelScope({ scope, scopedLoad }) ||
      hasNonEmptyPluginIdScope(expectedPluginIds) ||
      scope === "all"
        ? { onlyPluginIds: expectedPluginIds }
        : {}),
    },
  );
  resolveOrLoadRuntimePluginRegistry(loadOptions);
  if (!scopedLoad) {
    pluginRegistryLoaded = scope;
  }
}

/**
 * Ensures every id in `onlyPluginIds` is loaded, without letting a scoped
 * load evict (and retire the live state of) whatever else is already active.
 *
 * `ensurePluginRegistryLoaded({ scope: "all", onlyPluginIds })` is a cache
 * hit-or-replace: if the active registry already satisfies onlyPluginIds it's
 * a no-op, but on a miss it calls loadOpenClawPlugins with exactly
 * onlyPluginIds, which activates a brand-new registry containing only that
 * scope — evicting (and, per cleanupReplacedPluginHostRegistry, tearing down
 * the live session/runtime state of) every other already-active plugin not
 * in onlyPluginIds (openclaw/openclaw#107408).
 *
 * This loads only the ids missing from the active registry (`publish:false`,
 * so the standalone result never becomes the live registry and never runs
 * clearActivatedPluginRuntimeState — see PluginLoadOptions.publish), then
 * merges those registrations into the active registry in place. Because the
 * active registry object is mutated rather than replaced, re-publishing it
 * via setActivePluginRegistry is a same-reference no-op for the
 * retire/cleanup path (previousRegistry === registry), so already-active
 * plugins are neither re-registered nor torn down.
 */
export function ensureScopedPluginsLoadedPreservingActive(params: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir: string;
  onlyPluginIds: string[];
}): void {
  const active: PluginRegistry | null = getActivePluginRegistry();
  if (!active) {
    // No active registry to preserve yet (first load in this process or
    // workspace) — an ordinary scoped load can't evict anything.
    loadOpenClawPlugins({
      config: params.config,
      activationSourceConfig: params.activationSourceConfig,
      workspaceDir: params.workspaceDir,
      onlyPluginIds: params.onlyPluginIds,
    });
    return;
  }

  const missingPluginIds = params.onlyPluginIds.filter(
    (pluginId) => !registryContainsRuntimePluginIds(active, [pluginId]),
  );
  if (missingPluginIds.length === 0) {
    return;
  }

  const missingRegistry = loadOpenClawPlugins({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    onlyPluginIds: missingPluginIds,
    activate: true,
    publish: false,
    cache: false,
  });

  mergeMissingPluginRegistryInto(active, missingRegistry, missingPluginIds);

  setActivePluginRegistry(
    active,
    getActivePluginRegistryKey() ?? undefined,
    getActivePluginRuntimeSubagentMode(),
    getActivePluginRegistryWorkspaceDir(),
  );
  initializeGlobalHookRunner(active);
}

export const testing = {
  resetPluginRegistryLoadedForTests(): void {
    pluginRegistryLoaded = "none";
  },
};
export { testing as __testing };
