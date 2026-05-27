import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshotState,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import {
  resolvePluginControlPlaneFingerprint,
  type ResolvePluginControlPlaneContextParams,
} from "./plugin-control-plane-context.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { resolvePluginCacheInputs } from "./roots.js";

type CurrentPluginMetadataSnapshotState = ReturnType<typeof getCurrentPluginMetadataSnapshotState>;
type CurrentPluginMetadataConfigCacheEntry = {
  configFingerprint: string;
  discoveryKey: string;
  policyHash: string;
  policyKey: string;
};

let currentPluginMetadataConfigIdentityCache = new WeakMap<
  OpenClawConfig,
  CurrentPluginMetadataConfigCacheEntry
>();

export function resolvePluginMetadataControlPlaneFingerprint(
  config?: OpenClawConfig,
  options: Omit<ResolvePluginControlPlaneContextParams, "config"> = {},
): string {
  return resolvePluginControlPlaneFingerprint({
    config,
    ...options,
  });
}

export function isReusableCurrentPluginMetadataSnapshot(
  _snapshot: PluginMetadataSnapshot,
): boolean {
  return true;
}

function resolveConfiguredPluginLoadPaths(
  config: OpenClawConfig | undefined,
): readonly string[] | undefined {
  const paths = config?.plugins?.load?.paths;
  return Array.isArray(paths) ? paths : undefined;
}

function resolveCurrentPluginMetadataDiscoveryKey(params: {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): string {
  return JSON.stringify(
    resolvePluginCacheInputs({
      env: params.env,
      workspaceDir: params.workspaceDir,
      loadPaths: [...(resolveConfiguredPluginLoadPaths(params.config) ?? [])],
    }),
  );
}

function resolveCurrentPluginMetadataPolicyKey(config: OpenClawConfig | undefined): string {
  const plugins = config?.plugins;
  const rawEntries = plugins?.entries;
  const entries: Record<string, unknown> = {};
  if (rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries)) {
    for (const [pluginId, entry] of Object.entries(rawEntries)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const enabled = (entry as Record<string, unknown>).enabled;
        if (enabled !== undefined) {
          entries[pluginId] = enabled;
        }
      }
    }
  }
  const channelPolicy: Record<string, boolean> = {};
  const channels = config?.channels;
  if (channels && typeof channels === "object" && !Array.isArray(channels)) {
    for (const [channelId, value] of Object.entries(channels)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const enabled = (value as Record<string, unknown>).enabled;
        if (typeof enabled === "boolean") {
          channelPolicy[channelId] = enabled;
        }
      }
    }
  }
  return JSON.stringify({
    plugins: {
      enabled: plugins?.enabled,
      allow: plugins?.allow,
      deny: plugins?.deny,
      slots: plugins?.slots,
      entries,
    },
    channels: channelPolicy,
  });
}

// Single-slot Gateway-owned handoff. Replace or clear it at lifecycle boundaries;
// never accumulate historical metadata snapshots here.
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: {
    config?: OpenClawConfig;
    compatibleConfigs?: readonly OpenClawConfig[];
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
  } = {},
): void {
  currentPluginMetadataConfigIdentityCache = new WeakMap();
  const compatiblePolicyHashes = snapshot
    ? options.compatibleConfigs?.map((config) => resolveInstalledPluginIndexPolicyHash(config))
    : undefined;
  const compatibleConfigFingerprints = snapshot
    ? options.compatibleConfigs?.map((config, index) =>
        resolvePluginMetadataControlPlaneFingerprint(config, {
          env: options.env,
          index: snapshot.index,
          policyHash: compatiblePolicyHashes?.[index],
          workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
        }),
      )
    : undefined;
  setCurrentPluginMetadataSnapshotState(
    snapshot,
    snapshot
      ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
          env: options.env,
          index: snapshot.index,
          policyHash: snapshot.policyHash,
          workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
        })
      : undefined,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  );
  if (!snapshot) {
    return;
  }
  const env = options.env ?? process.env;
  const workspaceDir = options.workspaceDir ?? snapshot.workspaceDir;
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config);
    const policyKey = resolveCurrentPluginMetadataPolicyKey(options.config);
    const discoveryKey = resolveCurrentPluginMetadataDiscoveryKey({
      config: options.config,
      env,
      workspaceDir,
    });
    currentPluginMetadataConfigIdentityCache.set(options.config, {
      policyHash,
      policyKey,
      discoveryKey,
      configFingerprint: resolvePluginMetadataControlPlaneFingerprint(options.config, {
        env,
        index: snapshot.index,
        policyHash,
        workspaceDir,
      }),
    });
  }
  for (const [index, config] of (options.compatibleConfigs ?? []).entries()) {
    const policyHash = compatiblePolicyHashes?.[index];
    const configFingerprint = compatibleConfigFingerprints?.[index];
    if (!policyHash || !configFingerprint) {
      continue;
    }
    currentPluginMetadataConfigIdentityCache.set(config, {
      policyHash,
      policyKey: resolveCurrentPluginMetadataPolicyKey(config),
      configFingerprint,
      discoveryKey: resolveCurrentPluginMetadataDiscoveryKey({
        config,
        env,
        workspaceDir,
      }),
    });
  }
}

export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache = new WeakMap();
  clearCurrentPluginMetadataSnapshotState();
}

export function captureCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotState {
  return getCurrentPluginMetadataSnapshotState();
}

export function restoreCurrentPluginMetadataSnapshotState(
  state: CurrentPluginMetadataSnapshotState,
): void {
  currentPluginMetadataConfigIdentityCache = new WeakMap();
  setCurrentPluginMetadataSnapshotState(
    state.snapshot,
    state.configFingerprint,
    state.compatiblePolicyHashes,
    state.compatibleConfigFingerprints,
  );
}

export function getCurrentPluginMetadataSnapshot(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    allowWorkspaceScopedSnapshot?: boolean;
    requireDefaultDiscoveryContext?: boolean;
  } = {},
): PluginMetadataSnapshot | undefined {
  const {
    snapshot: rawSnapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  } = getCurrentPluginMetadataSnapshotState();
  const snapshot = rawSnapshot as PluginMetadataSnapshot | undefined;
  if (!snapshot) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const requestedWorkspaceDir =
    params.workspaceDir ??
    (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : undefined);
  const cachedConfig = params.config && currentPluginMetadataConfigIdentityCache.get(params.config);
  const requestedPolicyKey =
    params.config && cachedConfig
      ? resolveCurrentPluginMetadataPolicyKey(params.config)
      : undefined;
  const requestedDiscoveryKey =
    params.config && cachedConfig
      ? resolveCurrentPluginMetadataDiscoveryKey({
          config: params.config,
          env,
          workspaceDir: requestedWorkspaceDir,
        })
      : undefined;
  const canReuseCachedConfig =
    cachedConfig !== undefined &&
    cachedConfig.policyKey === requestedPolicyKey &&
    cachedConfig.discoveryKey === requestedDiscoveryKey;
  const requestedPolicyHash = canReuseCachedConfig
    ? cachedConfig.policyHash
    : params.config
      ? resolveInstalledPluginIndexPolicyHash(params.config)
      : undefined;
  if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
    const compatiblePolicies = new Set(compatiblePolicyHashes ?? []);
    if (!compatiblePolicies.has(requestedPolicyHash)) {
      return undefined;
    }
  }
  if (params.config) {
    const requestedConfigFingerprint = canReuseCachedConfig
      ? cachedConfig.configFingerprint
      : resolvePluginMetadataControlPlaneFingerprint(params.config, {
          env,
          index: snapshot.index,
          policyHash: requestedPolicyHash,
          workspaceDir: requestedWorkspaceDir,
        });
    const compatibleFingerprints = new Set(compatibleConfigFingerprints ?? []);
    const fingerprintMatches =
      configFingerprint === requestedConfigFingerprint ||
      snapshot.configFingerprint === requestedConfigFingerprint ||
      compatibleFingerprints.has(requestedConfigFingerprint);
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  if (params.requireDefaultDiscoveryContext === true) {
    const defaultDiscoveryConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(
      {},
      {
        env: params.env,
        index: snapshot.index,
        policyHash: snapshot.policyHash,
        workspaceDir: requestedWorkspaceDir,
      },
    );
    const compatibleFingerprints = new Set(compatibleConfigFingerprints ?? []);
    const fingerprintMatches =
      configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      compatibleFingerprints.has(defaultDiscoveryConfigFingerprint);
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  if (snapshot.workspaceDir !== undefined && requestedWorkspaceDir === undefined) {
    return undefined;
  }
  if (
    requestedWorkspaceDir !== undefined &&
    (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "")
  ) {
    return undefined;
  }
  return snapshot;
}
