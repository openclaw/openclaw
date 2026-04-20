import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { normalizeActivationRouteId } from "./route-id-normalize.js";

function dedupeSortedPluginIds(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function normalizeRouteIds(routeIds: Iterable<string>): string[] {
  return dedupeSortedPluginIds(
    [...routeIds]
      .map((routeId) => normalizeActivationRouteId(normalizeOptionalLowercaseString(routeId) ?? ""))
      .filter((routeId): routeId is string => Boolean(routeId)),
  );
}

function isRoutePluginEligibleForRuntimeOwnerActivation(params: {
  plugin: PluginManifestRecord;
  normalizedConfig: ReturnType<typeof normalizePluginsConfig>;
  rootConfig: OpenClawConfig;
}): boolean {
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    })
  ) {
    return false;
  }
  if (isBundledManifestOwner(params.plugin)) {
    return true;
  }
  if (params.plugin.origin === "global" || params.plugin.origin === "config") {
    return hasExplicitManifestOwnerTrust({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
    });
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
  });
}

export function resolveScopedRoutePluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  routeIds: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  cache?: boolean;
}): string[] {
  const routeIds = normalizeRouteIds(params.routeIds);
  if (routeIds.length === 0) {
    return [];
  }
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: params.cache,
  });
  const trustConfig = params.activationSourceConfig ?? params.config;
  const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
  const candidateIds = dedupeSortedPluginIds(
    routeIds.flatMap((routeId) =>
      resolveManifestActivationPluginIds({
        trigger: {
          kind: "route",
          route: routeId,
        },
        manifestRegistry: registry,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: params.cache,
      }),
    ),
  );
  if (candidateIds.length === 0) {
    return [];
  }
  const candidateIdSet = new Set(candidateIds);
  return registry.plugins
    .filter(
      (plugin) =>
        candidateIdSet.has(plugin.id) &&
        isRoutePluginEligibleForRuntimeOwnerActivation({
          plugin,
          normalizedConfig,
          rootConfig: trustConfig,
        }),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}
