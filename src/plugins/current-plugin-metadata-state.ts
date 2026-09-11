// Holds current plugin metadata snapshots for process-scoped consumers.
import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  adoptProcessPluginCache,
  getPluginCache,
  getProcessPluginCache,
  type PluginCache,
} from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

/** Selects an owned inventory and its prepared process-wide normalization policy together. */
export function selectCurrentPluginMetadataCache(cache: PluginCache): void {
  adoptProcessPluginCache(cache);
  const state = cache.metadata.current;
  setCurrentManifestModelIdNormalizationPolicies(
    state.owner === "gateway" || state.defaultDiscoveryCompatible
      ? state.snapshot?.owners.modelIdNormalizationPolicies
      : undefined,
  );
}

/** Owns config identity reuse for the current immutable metadata snapshot. */
export const currentPluginMetadataConfigIdentityCache = {
  add(config: OpenClawConfig): void {
    getProcessPluginCache().metadata.current.configIdentities.add(config);
  },
  clear(): void {
    getProcessPluginCache().metadata.current.configIdentities = new WeakSet();
  },
  has(config: OpenClawConfig): boolean {
    return getProcessPluginCache().metadata.current.configIdentities.has(config);
  },
};

/** Stores the process-current plugin metadata snapshot and compatible config fingerprints. */
export function setCurrentPluginMetadataSnapshotState(
  snapshot: PluginMetadataSnapshot | undefined,
  configFingerprint: string | undefined,
  compatiblePolicyHashes?: readonly string[],
  compatibleConfigFingerprints?: readonly string[],
  modelIdNormalizationPolicies?: PluginMetadataSnapshot["owners"]["modelIdNormalizationPolicies"],
  owner: "gateway" | "operation" = "operation",
  envFingerprint?: string,
  defaultDiscoveryCompatible = false,
): void {
  const state = getProcessPluginCache().metadata.current;
  state.snapshot = snapshot;
  state.owner = owner;
  state.configFingerprint = snapshot ? configFingerprint : undefined;
  state.envFingerprint = snapshot ? envFingerprint : undefined;
  state.defaultDiscoveryCompatible = Boolean(snapshot && defaultDiscoveryCompatible);
  state.compatiblePolicyHashes = snapshot ? compatiblePolicyHashes : undefined;
  state.compatibleConfigFingerprints = snapshot ? compatibleConfigFingerprints : undefined;
  setCurrentManifestModelIdNormalizationPolicies(
    snapshot ? modelIdNormalizationPolicies : undefined,
  );
  state.revision = Symbol("plugin-metadata-snapshot");
}

/** Clears the snapshot, its identity cache, and process-wide model normalization. */
export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataConfigIdentityCache.clear();
  setCurrentPluginMetadataSnapshotState(undefined, undefined);
}

/** Install-ledger writes cannot retire metadata owned by a running Gateway. */
export function isGatewayPluginMetadataSnapshotActive(): boolean {
  const state = getProcessPluginCache().metadata.current;
  return state.owner === "gateway" && state.snapshot !== undefined;
}

/** Reads the boot inventory without importing discovery into lightweight consumers. */
export function getGatewayPluginMetadataSnapshot(): PluginMetadataSnapshot | undefined {
  const cache = getPluginCache();
  if (cache.kind === "process" && cache.metadata.current.owner === "gateway") {
    return cache.metadata.current.snapshot;
  }
  return undefined;
}

/** Management compares a fresh candidate with boot state without making boot its read context. */
export function getProcessGatewayPluginMetadataSnapshot(): PluginMetadataSnapshot | undefined {
  if (isGatewayPluginMetadataSnapshotActive()) {
    return getProcessPluginCache().metadata.current.snapshot;
  }
  return undefined;
}

/** Captures the current snapshot and the policies eligible for process-wide publication. */
export function getCurrentPluginMetadataSnapshotState() {
  const state = getProcessPluginCache().metadata.current;
  return {
    snapshot: state.snapshot,
    owner: state.owner,
    configFingerprint: state.configFingerprint,
    envFingerprint: state.envFingerprint,
    defaultDiscoveryCompatible: state.defaultDiscoveryCompatible,
    compatiblePolicyHashes: state.compatiblePolicyHashes,
    compatibleConfigFingerprints: state.compatibleConfigFingerprints,
    revision: state.revision,
  };
}
