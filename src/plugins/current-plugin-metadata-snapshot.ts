import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveImmutableInstallIdentity } from "./candidate-install-owner.js";
import type {
  PluginMetadataSnapshotCandidate,
  ScopedPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.types.js";
import {
  currentPluginMetadataConfigIdentityCache,
  getGatewayPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
  selectCurrentPluginMetadataCache,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { safeRealpathSync } from "./path-safety.js";
import type { InspectionNativeEsmPolicy } from "./plugin-cache-artifacts.js";
import {
  getPluginMetadataSnapshotCache,
  getScopedPluginCaches,
  invalidatePluginCacheMetadata,
  getProcessPluginCache,
  getScopedPluginCache,
  runOutsidePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import {
  resolvePluginControlPlaneFingerprint,
  resolvePluginDiscoveryContext,
} from "./plugin-control-plane-context.js";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
  runWithPluginExecutionFrame,
} from "./plugin-instance-invocation.js";
import type { PluginExecutionFrame } from "./plugin-instance-invocation.types.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import { registerPluginMetadataSnapshotReaders } from "./plugin-metadata-snapshot-readers.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
} from "./plugin-metadata-snapshot.types.js";
import {
  preparePluginNativeAdmissions,
  publishInspectionNativeEsmPolicy,
} from "./plugin-native-admission-state.js";
import {
  resolvePluginRuntimeArtifactSelection,
  resolvePluginRuntimeExecutionArtifact,
} from "./plugin-runtime-artifact-selection.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";

type CurrentPluginMetadataSnapshotOptions = {
  config?: OpenClawConfig;
  compatibleConfigs?: readonly OpenClawConfig[];
  env?: NodeJS.ProcessEnv;
  /** Only immutable runtime generations may trust identity across policy drift. */
  trustConfigIdentity?: boolean;
  workspaceDir?: string;
};

export type CurrentPluginMetadataSnapshotParams = {
  /** Stop before policy-state validation so async owners can prepare it before retrying. */
  allowSynchronousPolicyRead?: boolean;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  allowScopedSnapshot?: boolean;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
  workspaceDir?: string;
  allowWorkspaceScopedSnapshot?: boolean;
  requireDefaultDiscoveryContext?: boolean;
};

export type PluginMetadataSnapshotScopeRunner = <T>(
  params: {
    config: OpenClawConfig;
    workspaceDir?: string;
  },
  run: () => T,
) => T;

function resolveAgentWorkspaceFingerprint(config: OpenClawConfig, env?: NodeJS.ProcessEnv): string {
  // Discovery order determines schema precedence; retain the canonical resolver's order.
  return JSON.stringify(listAgentWorkspaceDirs(config, env));
}

function prepareInspectionNativeEsmPolicy(
  snapshot: PluginMetadataSnapshot,
  workspaces: readonly string[],
  options: CurrentPluginMetadataSnapshotOptions,
): InspectionNativeEsmPolicy {
  const sources = new Map<string, string>();
  const manifests = new Map(
    snapshot.manifestRegistry.plugins.map((manifest) => [
      `${manifest.rootDir}\0${manifest.id}`,
      manifest,
    ]),
  );
  for (const record of snapshot.index.plugins) {
    const identity = resolveImmutableInstallIdentity(
      record.origin,
      resolveInstalledPluginIndexInstallOwner(record),
      snapshot.index.installRecords,
    );
    const manifest = manifests.get(`${record.rootDir}\0${record.pluginId}`);
    if (!identity || !manifest) {
      continue;
    }
    for (const entryKind of ["runtime", "setup"] as const) {
      const source = entryKind === "runtime" ? manifest.source : manifest.setupSource;
      if (!source) {
        continue;
      }
      for (const preferBuiltPluginArtifacts of [false, true]) {
        const artifact = resolvePluginRuntimeExecutionArtifact(
          resolvePluginRuntimeArtifactSelection({
            ...manifest,
            source,
            entryKind,
            preferBuiltPluginArtifacts,
          }),
        );
        const canonicalSource = safeRealpathSync(artifact.source);
        if (canonicalSource) {
          sources.set(canonicalSource, identity);
        }
      }
    }
  }
  return {
    workspaces: new Set(workspaces),
    sources,
    devSourceRoot: resolvePluginDiscoveryContext({
      config: options.config,
      env: options.env,
      workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
    }).devSourceRoot,
  };
}

function prepareConfigCompatibility(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions,
  fingerprint: (config: OpenClawConfig, policyHash: string | undefined) => string,
  trustConfigIdentity = false,
) {
  const compatiblePolicyHashes = options.compatibleConfigs?.map((config) =>
    resolveInstalledPluginIndexPolicyHash(config, options.env),
  );
  const compatibleConfigFingerprints = options.compatibleConfigs?.map((config, index) =>
    fingerprint(config, compatiblePolicyHashes?.[index]),
  );
  const configIdentities = [...(options.compatibleConfigs ?? [])];
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config, options.env);
    if (
      trustConfigIdentity ||
      policyHash === snapshot.policyHash ||
      compatiblePolicyHashes?.includes(policyHash)
    ) {
      configIdentities.push(options.config);
    }
  }
  return { compatibleConfigFingerprints, configIdentities };
}

function prepareCurrentPluginMetadataSnapshotPublication(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions,
  owner: "gateway" | "operation" = "operation",
): () => void {
  const fingerprint = (config: OpenClawConfig | undefined, policyHash: string | undefined) =>
    resolvePluginControlPlaneFingerprint({
      config,
      env: options.env,
      index: snapshot.index,
      policyHash,
      workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
    });
  const { compatibleConfigFingerprints, configIdentities } = prepareConfigCompatibility(
    snapshot,
    options,
    fingerprint,
  );
  const configFingerprint = fingerprint(options.config, snapshot.policyHash);
  const defaultDiscoveryConfigFingerprint = fingerprint({}, snapshot.policyHash);
  const defaultDiscoveryCompatible =
    configFingerprint === defaultDiscoveryConfigFingerprint ||
    snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
    Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint));
  const envFingerprint = resolvePluginMetadataEnvFingerprint(options.env);
  const agentWorkspaces =
    owner === "gateway" && options.config
      ? listAgentWorkspaceDirs(options.config, options.env)
      : undefined;
  const agentWorkspaceFingerprint = agentWorkspaces && JSON.stringify(agentWorkspaces);
  const inspectionPolicy =
    agentWorkspaces && prepareInspectionNativeEsmPolicy(snapshot, agentWorkspaces, options);
  return () => {
    if (getCurrentPluginMetadataSnapshotState().owner === "gateway" && owner !== "gateway") {
      throw new Error("Gateway plugin metadata can only be replaced after shutdown");
    }
    currentPluginMetadataConfigIdentityCache.clear();
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      configFingerprint,
      compatibleConfigFingerprints,
      owner === "gateway" || defaultDiscoveryCompatible
        ? snapshot.owners.modelIdNormalizationPolicies
        : undefined,
      owner,
      envFingerprint,
      defaultDiscoveryCompatible,
      agentWorkspaceFingerprint,
    );
    if (inspectionPolicy) {
      publishInspectionNativeEsmPolicy(getProcessPluginCache(), inspectionPolicy);
    }
    for (const config of configIdentities) {
      currentPluginMetadataConfigIdentityCache.add(config);
    }
  };
}

/** Prepares fingerprints before the Gateway's synchronous runtime publication edge. */
export function prepareGatewayPluginMetadataSnapshotPublication(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions = {},
): () => void {
  if (snapshot.pluginIds !== undefined) {
    throw new Error("Gateway plugin metadata must include the complete startup inventory");
  }
  const cache = getPluginMetadataSnapshotCache(snapshot);
  const publish = withPluginCache(cache, () =>
    prepareCurrentPluginMetadataSnapshotPublication(snapshot, options, "gateway"),
  );
  return () => {
    selectCurrentPluginMetadataCache(cache);
    publish();
  };
}

/** Only the Gateway lifecycle publishes a complete replacement inventory. */
export function setGatewayPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: CurrentPluginMetadataSnapshotOptions = {},
): void {
  if (snapshot) {
    prepareGatewayPluginMetadataSnapshotPublication(snapshot, options)();
  }
}

/** Publishes a prepared CLI snapshot without displacing a lifecycle owner. */
export function adoptCurrentPluginMetadataSnapshotIfAbsent(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions = {},
): void {
  if (
    getScopedPluginCache()?.kind === "operation" ||
    getCurrentPluginMetadataSnapshotState().snapshot !== undefined
  ) {
    return;
  }
  prepareCurrentPluginMetadataSnapshotPublication(snapshot, options)();
}

/** Explicit installation refreshes the command before its next metadata phase. */
function clearCurrentPluginMetadataOperation(): void {
  const caches = new Set(getScopedPluginCaches());
  const runtimeCaches = new Set();
  for (let scope = getPluginExecutionFrame()?.metadataScope; scope; scope = scope.parent) {
    if (scope.immutableRuntimeGeneration) {
      runtimeCaches.add(scope.cache);
    } else {
      caches.add(scope.cache);
    }
  }
  for (const cache of caches) {
    if (cache.kind === "operation" && !runtimeCaches.has(cache)) {
      invalidatePluginCacheMetadata(cache);
    }
  }
}

function isScopedSnapshotInCurrentCache(scoped: ScopedPluginMetadataSnapshot): boolean {
  if (!scoped.immutableRuntimeGeneration && scoped.metadata !== scoped.cache.metadata) {
    return false;
  }
  const cache = getScopedPluginCache();
  return cache?.kind !== "operation" || scoped.cache === cache;
}

/** Carries one owner-prepared metadata generation through nested async plugin lookups. */
export function withPluginMetadataSnapshotScope<T>(
  snapshot: PluginMetadataSnapshot,
  run: () => T,
  options: CurrentPluginMetadataSnapshotOptions = {},
): T {
  return runWithPluginExecutionFrame(createPluginMetadataSnapshotFrame(snapshot, options), run);
}

/** Compose metadata and its cache before the runtime owner enters the async scope. */
export function createPluginMetadataSnapshotFrame(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions = {},
): PluginExecutionFrame {
  const current = getPluginExecutionFrame();
  const cache = getPluginMetadataSnapshotCache(snapshot);
  // A retained metadata owner can be borrowed inside a different private state view.
  preparePluginNativeAdmissions(snapshot.index, cache);
  const workspaceDir = options.workspaceDir ?? snapshot.workspaceDir;
  const fingerprint = (config: OpenClawConfig, policyHash: string | undefined) =>
    resolvePluginControlPlaneFingerprint({
      config,
      env: options.env,
      inventoryFingerprint: withPluginCache(cache, () =>
        resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
      ),
      policyHash,
      workspaceDir,
    });
  const { compatibleConfigFingerprints, configIdentities } = prepareConfigCompatibility(
    snapshot,
    options,
    fingerprint,
    options.trustConfigIdentity === true,
  );
  const configFingerprint = options.config
    ? fingerprint(options.config, snapshot.policyHash)
    : snapshot.configFingerprint;
  const capturedConfigIdentities = new WeakSet(configIdentities);
  return createPluginExecutionFrame(
    {
      ...current,
      cacheScope: { cache, parent: current?.cacheScope },
      metadataScope: {
        snapshot,
        cache,
        metadata: cache.metadata,
        configFingerprint,
        envFingerprint: resolvePluginMetadataEnvFingerprint(options.env),
        compatibleConfigFingerprints,
        hasConfigIdentity: (config) => capturedConfigIdentities.has(config),
        immutableRuntimeGeneration: options.trustConfigIdentity === true,
        parent: current?.metadataScope,
      },
    },
    current,
  );
}

export function runOutsidePluginMetadataSnapshotScope<T>(run: () => T): T {
  const current = getPluginExecutionFrame();
  return runWithPluginExecutionFrame(
    createPluginExecutionFrame({ ...current, metadataScope: undefined }, current),
    () => runOutsidePluginCache(run),
  );
}

const NEEDS_PREPARED_POLICY = Symbol("needs-prepared-policy");

function resolveCompatiblePluginMetadataSnapshot(
  candidate: PluginMetadataSnapshotCandidate,
  params: CurrentPluginMetadataSnapshotParams,
  options: { scopedOwnerContext?: boolean } = {},
): PluginMetadataSnapshot | typeof NEEDS_PREPARED_POLICY | undefined {
  const snapshot = candidate.snapshot;
  if (!snapshot) {
    return undefined;
  }
  // Runtime selection projects the boot inventory in memory. Policy, run workspaces,
  // and narrower scopes must never send a runtime reader back into discovery.
  if (candidate.immutableRuntimeGeneration) {
    return snapshot;
  }
  const env = params.env ?? process.env;
  if (candidate.envFingerprint !== resolvePluginMetadataEnvFingerprint(env)) {
    return undefined;
  }
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
    (params.allowWorkspaceScopedSnapshot === true || options.scopedOwnerContext === true
      ? snapshot.workspaceDir
      : undefined);
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
    params.config && candidate.hasConfigIdentity?.(params.config),
  );
  if (canReuseCachedConfig && params.requireDefaultDiscoveryContext !== true) {
    return snapshot;
  }
  if (params.config && !canReuseCachedConfig && params.allowSynchronousPolicyRead === false) {
    return NEEDS_PREPARED_POLICY;
  }
  const requestedPolicyHash =
    params.config && !canReuseCachedConfig
      ? resolveInstalledPluginIndexPolicyHash(params.config, params.env)
      : undefined;
  if (params.config && !canReuseCachedConfig) {
    const requestedConfigFingerprint = resolvePluginControlPlaneFingerprint({
      config: params.config,
      env,
      index: snapshot.index,
      policyHash: requestedPolicyHash,
      workspaceDir: requestedWorkspaceDir,
    });
    const fingerprintMatches =
      candidate.configFingerprint === requestedConfigFingerprint ||
      snapshot.configFingerprint === requestedConfigFingerprint ||
      Boolean(candidate.compatibleConfigFingerprints?.includes(requestedConfigFingerprint));
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  if (
    params.requireDefaultDiscoveryContext === true &&
    options.scopedOwnerContext !== true &&
    candidate.defaultDiscoveryCompatible !== true
  ) {
    return undefined;
  }
  return snapshot;
}

/** Reads Gateway-owned metadata from an operation cache only when its inputs still match. */
export function getCompatibleProcessGatewayPluginMetadataSnapshot(
  params: CurrentPluginMetadataSnapshotParams = {},
): PluginMetadataSnapshot | undefined {
  const state = getCurrentPluginMetadataSnapshotState();
  if (state.owner !== "gateway") {
    return undefined;
  }
  if (
    !params.config ||
    state.agentWorkspaceFingerprint !== resolveAgentWorkspaceFingerprint(params.config, params.env)
  ) {
    return undefined;
  }
  const compatible = resolveCompatiblePluginMetadataSnapshot(
    {
      ...state,
      hasConfigIdentity: (config) => currentPluginMetadataConfigIdentityCache.has(config),
    },
    params,
  );
  return compatible === NEEDS_PREPARED_POLICY ? undefined : compatible;
}

export function isCurrentPluginMetadataSnapshotRuntimeGeneration(
  snapshot: Pick<PluginMetadataSnapshot, "index">,
): boolean {
  const gatewaySnapshot = getGatewayPluginMetadataSnapshot();
  if (gatewaySnapshot && gatewaySnapshot.index === snapshot.index) {
    return true;
  }
  for (let scoped = getPluginExecutionFrame()?.metadataScope; scoped; scoped = scoped.parent) {
    if (!isScopedSnapshotInCurrentCache(scoped)) {
      continue;
    }
    if (scoped.snapshot?.index === snapshot.index && scoped.immutableRuntimeGeneration === true) {
      return true;
    }
  }
  return false;
}

export function getCurrentPluginMetadataSnapshot(
  params: CurrentPluginMetadataSnapshotParams = {},
): PluginMetadataSnapshot | undefined {
  for (let scoped = getPluginExecutionFrame()?.metadataScope; scoped; scoped = scoped.parent) {
    if (!isScopedSnapshotInCurrentCache(scoped)) {
      continue;
    }
    // An explicit async owner scope is the discovery context for nested configless readers.
    // Global snapshots still require proof that they match the default discovery context.
    const compatibleScoped = resolveCompatiblePluginMetadataSnapshot(scoped, params, {
      scopedOwnerContext: true,
    });
    if (compatibleScoped === NEEDS_PREPARED_POLICY) {
      return undefined;
    }
    if (compatibleScoped) {
      return compatibleScoped;
    }
  }

  const scopedCache = getScopedPluginCache();
  if (scopedCache && scopedCache !== getProcessPluginCache()) {
    return undefined;
  }

  const state = getCurrentPluginMetadataSnapshotState();
  const compatible = resolveCompatiblePluginMetadataSnapshot(
    {
      ...state,
      hasConfigIdentity: (config) => currentPluginMetadataConfigIdentityCache.has(config),
      immutableRuntimeGeneration: state.owner === "gateway",
    },
    params,
  );
  return compatible === NEEDS_PREPARED_POLICY ? undefined : compatible;
}

// Register before callers can publish a snapshot; current-only light bridge
// reads consume this owner without loading a cold metadata graph.
registerPluginMetadataSnapshotReaders({
  adoptCurrentPluginMetadataSnapshotIfAbsent,
  getCurrentPluginMetadataSnapshot,
});

registerPluginMetadataProcessMemoLifecycleClear(clearCurrentPluginMetadataOperation, {
  owner: "operation",
});
