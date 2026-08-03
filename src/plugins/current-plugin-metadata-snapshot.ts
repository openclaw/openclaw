/** Tracks the current plugin metadata snapshot for control-plane lookups. */
import { setCurrentManifestModelIdNormalizationRecords } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  currentPluginMetadataConfigIdentityCache,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import {
  resolvePluginControlPlaneFingerprint,
  type ResolvePluginControlPlaneContextParams,
} from "./plugin-control-plane-context.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
} from "./plugin-metadata-snapshot.types.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";

type CurrentPluginMetadataSnapshotState = ReturnType<
  typeof getCurrentPluginMetadataSnapshotState
> & {
  configIdentities: WeakSet<OpenClawConfig>;
};

function resolvePluginMetadataControlPlaneFingerprint(
  config?: OpenClawConfig,
  options: Omit<ResolvePluginControlPlaneContextParams, "config"> = {},
): string {
  return resolvePluginControlPlaneFingerprint({
    config,
    ...options,
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
  currentPluginMetadataConfigIdentityCache.clear();
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
  const configFingerprint = snapshot
    ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
        env: options.env,
        index: snapshot.index,
        policyHash: snapshot.policyHash,
        workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
      })
    : undefined;
  const defaultDiscoveryConfigFingerprint = snapshot
    ? resolvePluginMetadataControlPlaneFingerprint(
        {},
        {
          env: options.env,
          index: snapshot.index,
          policyHash: snapshot.policyHash,
          workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
        },
      )
    : undefined;
  const defaultDiscoveryCompatible =
    snapshot &&
    defaultDiscoveryConfigFingerprint &&
    (configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint)));
  setCurrentManifestModelIdNormalizationRecords(
    defaultDiscoveryCompatible ? snapshot.plugins : undefined,
  );
  setCurrentPluginMetadataSnapshotState(
    snapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  );
  if (!snapshot) {
    return;
  }
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config);
    if (
      policyHash === snapshot.policyHash ||
      Boolean(compatiblePolicyHashes?.includes(policyHash))
    ) {
      currentPluginMetadataConfigIdentityCache.add(options.config);
    }
  }
  for (const config of options.compatibleConfigs ?? []) {
    currentPluginMetadataConfigIdentityCache.add(config);
  }
}

export function captureCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotState {
  return {
    ...getCurrentPluginMetadataSnapshotState(),
    configIdentities: currentPluginMetadataConfigIdentityCache.capture(),
  };
}

export function restoreCurrentPluginMetadataSnapshotState(
  state: CurrentPluginMetadataSnapshotState,
): void {
  currentPluginMetadataConfigIdentityCache.restore(state.configIdentities);
  const snapshot = state.snapshot as PluginMetadataSnapshot | undefined;
  const defaultDiscoveryConfigFingerprint = snapshot
    ? resolvePluginMetadataControlPlaneFingerprint(
        {},
        {
          index: snapshot.index,
          policyHash: snapshot.policyHash,
          workspaceDir: snapshot.workspaceDir,
        },
      )
    : undefined;
  const defaultDiscoveryCompatible =
    snapshot &&
    defaultDiscoveryConfigFingerprint &&
    (state.configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      Boolean(state.compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint)));
  setCurrentManifestModelIdNormalizationRecords(
    defaultDiscoveryCompatible ? snapshot.plugins : undefined,
  );
  setCurrentPluginMetadataSnapshotState(
    state.snapshot,
    state.configFingerprint,
    state.compatiblePolicyHashes,
    state.compatibleConfigFingerprints,
  );
}

function isCompletePluginMetadataSnapshot(value: unknown): value is PluginMetadataSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<PluginMetadataSnapshot>;
  return (
    typeof snapshot.policyHash === "string" &&
    snapshot.index !== undefined &&
    snapshot.manifestRegistry !== undefined
  );
}

/** Publishes a command's prepared snapshot into the process-current slot for its own run.
 *
 * Routed cold commands build one snapshot and then call helpers that consult the
 * slot before falling back to a full `loadPluginMetadataSnapshot` scan. Without an
 * install each of those helpers repeats discovery. The returned closure must run in
 * the command's `finally`: the slot is a single lifecycle-owned handoff, so a leaked
 * install would serve one invocation's metadata to the next in-process command. */
export function installCommandPluginMetadataSnapshot(params: {
  snapshot: PluginMetadataSnapshot;
  config: OpenClawConfig | undefined;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): () => void {
  if (!isCompletePluginMetadataSnapshot(params.snapshot)) {
    return () => {};
  }
  // An existing install belongs to an outer owner (gateway startup, a wrapping
  // command); never replace it, or that owner's restore would publish our snapshot.
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (current) {
    return () => {};
  }
  const previousState = captureCurrentPluginMetadataSnapshotState();
  setCurrentPluginMetadataSnapshot(params.snapshot, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return () => {
    restoreCurrentPluginMetadataSnapshotState(previousState);
  };
}

export function getCurrentPluginMetadataSnapshot(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    allowScopedSnapshot?: boolean;
    pluginIds?: readonly string[];
    pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
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
  const requestedPluginIds = normalizePluginIdScope(
    params.pluginIds ?? params.pluginIdScope?.resolve({ index: snapshot.index }),
  );
  const snapshotPluginIds = normalizePluginIdScope(snapshot.pluginIds);
  if (
    requestedPluginIds !== undefined &&
    serializePluginIdScope(snapshotPluginIds) !== serializePluginIdScope(requestedPluginIds)
  ) {
    return undefined;
  }
  if (
    snapshotPluginIds !== undefined &&
    requestedPluginIds === undefined &&
    params.allowScopedSnapshot !== true
  ) {
    return undefined;
  }
  const requestedWorkspaceDir =
    params.workspaceDir ??
    (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : undefined);
  if (snapshot.workspaceDir !== undefined && requestedWorkspaceDir === undefined) {
    return undefined;
  }
  if (
    requestedWorkspaceDir !== undefined &&
    (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "")
  ) {
    return undefined;
  }
  const canReuseCachedConfig = Boolean(
    params.config && currentPluginMetadataConfigIdentityCache.has(params.config),
  );
  if (canReuseCachedConfig && params.requireDefaultDiscoveryContext !== true) {
    return snapshot;
  }
  const requestedPolicyHash =
    params.config && !canReuseCachedConfig
      ? resolveInstalledPluginIndexPolicyHash(params.config)
      : undefined;
  if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
    if (!compatiblePolicyHashes?.includes(requestedPolicyHash)) {
      return undefined;
    }
  }
  if (params.config && !canReuseCachedConfig) {
    const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
      env,
      index: snapshot.index,
      policyHash: requestedPolicyHash,
      workspaceDir: requestedWorkspaceDir,
    });
    const fingerprintMatches =
      configFingerprint === requestedConfigFingerprint ||
      snapshot.configFingerprint === requestedConfigFingerprint ||
      Boolean(compatibleConfigFingerprints?.includes(requestedConfigFingerprint));
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
    const fingerprintMatches =
      configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint));
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  return snapshot;
}
