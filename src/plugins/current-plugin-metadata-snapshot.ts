import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
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
  type ResolvePluginControlPlaneContextParams,
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
  requireAgentWorkspaceCompatibility?: boolean;
};

export type PluginMetadataSnapshotScopeRunner = <T>(
  params: {
    config: OpenClawConfig;
    workspaceDir?: string;
  },
  run: () => T,
) => T;

function resolvePluginMetadataControlPlaneFingerprint(
  config?: OpenClawConfig,
  options: Omit<ResolvePluginControlPlaneContextParams, "config"> = {},
): string {
  return resolvePluginControlPlaneFingerprint({ config, ...options });
}

function resolveAgentWorkspaceFingerprint(config: OpenClawConfig, env?: NodeJS.ProcessEnv): string {
  // Discovery order determines schema precedence; retain the canonical resolver's order.
  return JSON.stringify(listAgentWorkspaceDirs(config, env));
}

function prepareCurrentPluginMetadataSnapshotPublication(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions,
  owner: "gateway" | "operation" = "operation",
): () => void {
  const fingerprint = (config: OpenClawConfig | undefined, policyHash: string | undefined) =>
    resolvePluginMetadataControlPlaneFingerprint(config, {
      env: options.env,
      index: snapshot.index,
      policyHash,
      workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
    });
  const compatiblePolicyHashes = options.compatibleConfigs?.map((config) =>
    resolveInstalledPluginIndexPolicyHash(config, options.env),
  );
  const compatibleConfigFingerprints = options.compatibleConfigs?.map((config, index) =>
    fingerprint(config, compatiblePolicyHashes?.[index]),
  );
  const configFingerprint = fingerprint(options.config, snapshot.policyHash);
  const defaultDiscoveryConfigFingerprint = fingerprint({}, snapshot.policyHash);
  const defaultDiscoveryCompatible =
    configFingerprint === defaultDiscoveryConfigFingerprint ||
    snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
    Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint));
  const envFingerprint = resolvePluginMetadataEnvFingerprint(options.env);
  const agentWorkspaceFingerprint =
    owner === "gateway" && options.config
      ? resolveAgentWorkspaceFingerprint(options.config, options.env)
      : undefined;
  const configIdentities = [...(options.compatibleConfigs ?? [])];
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config, options.env);
    if (
      policyHash === snapshot.policyHash ||
      Boolean(compatiblePolicyHashes?.includes(policyHash))
    ) {
      configIdentities.push(options.config);
    }
  }
  return () => {
    if (getCurrentPluginMetadataSnapshotState().owner === "gateway" && owner !== "gateway") {
      throw new Error("Gateway plugin metadata can only be replaced after shutdown");
    }
    currentPluginMetadataConfigIdentityCache.clear();
    setCurrentPluginMetadataSnapshotState(
      snapshot,
      configFingerprint,
      compatiblePolicyHashes,
      compatibleConfigFingerprints,
      owner === "gateway" || defaultDiscoveryCompatible
        ? snapshot.owners.modelIdNormalizationPolicies
        : undefined,
      owner,
      envFingerprint,
      defaultDiscoveryCompatible,
      agentWorkspaceFingerprint,
    );
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

/** Installation revokes operation facts even when it runs between metadata scopes. */
function revokeCurrentPluginMetadataSnapshotScopes(): void {
  const caches = new Set(getScopedPluginCaches());
  const runtimeCaches = new Set();
  for (let scoped = getPluginExecutionFrame()?.metadataScope; scoped; scoped = scoped.parent) {
    if (scoped.immutableRuntimeGeneration) {
      runtimeCaches.add(scoped.cache);
    } else {
      caches.add(scoped.cache);
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
  const workspaceDir = options.workspaceDir ?? snapshot.workspaceDir;
  const fingerprint = (config: OpenClawConfig, policyHash: string | undefined) =>
    resolvePluginMetadataControlPlaneFingerprint(config, {
      env: options.env,
      inventoryFingerprint: withPluginCache(cache, () =>
        resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
      ),
      policyHash,
      workspaceDir,
    });
  const compatiblePolicyHashes = options.compatibleConfigs?.map((config) =>
    resolveInstalledPluginIndexPolicyHash(config, options.env),
  );
  const compatibleConfigFingerprints = options.compatibleConfigs?.map((config, index) =>
    fingerprint(config, compatiblePolicyHashes?.[index]),
  );
  const configFingerprint = options.config
    ? fingerprint(options.config, snapshot.policyHash)
    : snapshot.configFingerprint;
  const configIdentities = new WeakSet<OpenClawConfig>();
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config, options.env);
    if (
      options.trustConfigIdentity === true ||
      policyHash === snapshot.policyHash ||
      compatiblePolicyHashes?.includes(policyHash)
    ) {
      configIdentities.add(options.config);
    }
  }
  for (const config of options.compatibleConfigs ?? []) {
    configIdentities.add(config);
  }
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
        compatiblePolicyHashes,
        compatibleConfigFingerprints,
        hasConfigIdentity: (config) => configIdentities.has(config),
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
  if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
    if (!candidate.compatiblePolicyHashes?.includes(requestedPolicyHash)) {
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
  const {
    snapshot,
    owner,
    configFingerprint,
    agentWorkspaceFingerprint,
    envFingerprint,
    defaultDiscoveryCompatible,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  } = getCurrentPluginMetadataSnapshotState();
  if (owner !== "gateway") {
    return undefined;
  }
  if (
    params.requireAgentWorkspaceCompatibility === true &&
    (!params.config ||
      agentWorkspaceFingerprint !== resolveAgentWorkspaceFingerprint(params.config, params.env))
  ) {
    return undefined;
  }
  const compatible = resolveCompatiblePluginMetadataSnapshot(
    {
      // SAFETY: Gateway publication accepts only a complete typed metadata snapshot.
      snapshot: snapshot as PluginMetadataSnapshot | undefined,
      configFingerprint,
      envFingerprint,
      defaultDiscoveryCompatible,
      compatiblePolicyHashes,
      compatibleConfigFingerprints,
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

  const {
    snapshot,
    owner,
    configFingerprint,
    envFingerprint,
    defaultDiscoveryCompatible,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  } = getCurrentPluginMetadataSnapshotState();
  const compatible = resolveCompatiblePluginMetadataSnapshot(
    {
      snapshot,
      configFingerprint,
      envFingerprint,
      defaultDiscoveryCompatible,
      compatiblePolicyHashes,
      compatibleConfigFingerprints,
      hasConfigIdentity: (config) => currentPluginMetadataConfigIdentityCache.has(config),
      immutableRuntimeGeneration: owner === "gateway",
    },
    params,
  );
  return compatible === NEEDS_PREPARED_POLICY ? undefined : compatible;
}

// Light bridges (plugin-metadata-snapshot.runtime.ts) serve reads through this
// instance whenever the metadata system is loaded; the require fallback only
// covers cold processes.
registerPluginMetadataSnapshotReaders({
  adoptCurrentPluginMetadataSnapshotIfAbsent,
  getCurrentPluginMetadataSnapshot,
});

registerPluginMetadataProcessMemoLifecycleClear(revokeCurrentPluginMetadataSnapshotScopes, {
  owner: "operation",
});
