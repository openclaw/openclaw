// Runtime registry loader assembles activated plugin runtimes from config and registry metadata.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../activation-context.js";
import { getLoadedRuntimePluginRegistry } from "../active-runtime-registry.js";
import {
  resolveChannelPluginIds,
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../channel-plugin-ids.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "../default-enablement.js";
import { resolveEffectivePluginIds } from "../effective-plugin-ids.js";
import { resolveRequiredFinalToolInputPolicyOwnerIds } from "../final-tool-input-policy-requirements.js";
import { loadOpenClawPlugins } from "../loader.js";
import { formatAutoEnabledActivationReason } from "../loader-records.js";
import {
  hasExplicitPluginIdScope,
  hasNonEmptyPluginIdScope,
  normalizePluginIdScope,
} from "../plugin-scope.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  resolvePluginRuntimeLoadContext,
} from "./load-context.js";

export type PluginRegistryScope = "configured-channels" | "channels" | "all";

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

function resolvePreservedRequiredPolicyOwnerIds(params: {
  context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  requiredPolicyOwnerIds: readonly string[];
}): string[] {
  // A policy requirement is an assertion, never a trust grant. Preserve only
  // owners already eligible to register trusted hooks before scoping adds an allowlist.
  const runtimePlugins = normalizePluginsConfig(params.context.config.plugins);
  const sourcePlugins = normalizePluginsConfig(params.context.activationSourceConfig.plugins);
  if (!runtimePlugins.enabled || !sourcePlugins.enabled) {
    return [];
  }
  const effectivePlugins = {
    ...runtimePlugins,
    allow: [...new Set([...runtimePlugins.allow, ...sourcePlugins.allow])],
    deny: [...new Set([...runtimePlugins.deny, ...sourcePlugins.deny])],
  };
  const activationSource = createPluginActivationSource({
    config: params.context.activationSourceConfig,
    plugins: sourcePlugins,
  });
  const manifestsById = new Map(
    params.context.manifestRegistry?.plugins.map((plugin) => [plugin.id, plugin]),
  );
  return params.requiredPolicyOwnerIds.filter((pluginId) => {
    if (
      runtimePlugins.entries[pluginId]?.enabled === false ||
      sourcePlugins.entries[pluginId]?.enabled === false
    ) {
      return false;
    }
    const manifest = manifestsById.get(pluginId);
    const origin = manifest?.origin ?? "workspace";
    const activationState = resolveEffectivePluginActivationState({
      id: pluginId,
      origin,
      config: effectivePlugins,
      rootConfig: params.context.config,
      enabledByDefault: manifest
        ? isPluginEnabledByDefaultForPlatform(manifest)
        : undefined,
      activationSource,
      autoEnabledReason: formatAutoEnabledActivationReason(
        params.context.autoEnabledReasons[pluginId],
      ),
    });
    return activationState.enabled && (origin === "bundled" || activationState.explicitlyEnabled);
  });
}

function withConfiguredChannelScope(params: {
  config: OpenClawConfig;
  channelOwnerIds: readonly string[];
  preservedPolicyOwnerIds: readonly string[];
}): OpenClawConfig {
  const scoped =
    withActivatedPluginIds({
      config: params.config,
      pluginIds: params.channelOwnerIds,
    }) ?? params.config;
  if (params.preservedPolicyOwnerIds.length === 0) {
    return scoped;
  }
  const allow = normalizePluginIdScope([
    ...(scoped.plugins?.allow ?? []),
    ...params.preservedPolicyOwnerIds,
  ]) ?? [];
  return {
    ...scoped,
    plugins: {
      ...scoped.plugins,
      allow,
    },
  };
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
  const scopePluginIds = scopedLoad
    ? (requestedPluginIds ?? [])
    : resolveScopePluginIds({ scope, context });
  const requiredPolicyOwnerIds =
    normalizePluginIdScope([
      ...resolveRequiredFinalToolInputPolicyOwnerIds(context.config),
      ...resolveRequiredFinalToolInputPolicyOwnerIds(context.activationSourceConfig),
    ]) ?? [];
  const expectedPluginIds =
    normalizePluginIdScope([...scopePluginIds, ...requiredPolicyOwnerIds]) ?? [];
  const shouldApplyConfiguredChannelScope =
    scope === "configured-channels" &&
    scopePluginIds.length > 0 &&
    (!scopedLoad || requestedChannelOwnerPluginIds !== undefined);
  const preservedPolicyOwnerIds = shouldApplyConfiguredChannelScope
    ? resolvePreservedRequiredPolicyOwnerIds({ context, requiredPolicyOwnerIds })
    : [];
  const scopedConfig = shouldApplyConfiguredChannelScope
    ? withConfiguredChannelScope({
          config: context.config,
          channelOwnerIds: scopePluginIds,
          preservedPolicyOwnerIds,
        })
    : context.config;
  const scopedActivationSourceConfig = shouldApplyConfiguredChannelScope
    ? withConfiguredChannelScope({
          config: context.activationSourceConfig,
          channelOwnerIds: scopePluginIds,
          preservedPolicyOwnerIds,
        })
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
}
