import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

let currentPluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
let currentPluginMetadataSnapshotConfigFingerprint: string | undefined;

function normalizeLoadPaths(config: OpenClawConfig | undefined): readonly string[] {
  const paths = config?.plugins?.load?.paths;
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.filter((entry) => typeof entry === "string");
}

export function resolvePluginMetadataSnapshotConfigFingerprint(
  config: OpenClawConfig | undefined,
): string {
  return JSON.stringify({
    policyHash: resolveInstalledPluginIndexPolicyHash(config),
    pluginLoadPaths: normalizeLoadPaths(config),
  });
}

// Single-slot Gateway-owned handoff. Replace or clear it at lifecycle boundaries;
// never accumulate historical metadata snapshots here.
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: { config?: OpenClawConfig } = {},
): void {
  currentPluginMetadataSnapshot = snapshot;
  currentPluginMetadataSnapshotConfigFingerprint = snapshot
    ? resolvePluginMetadataSnapshotConfigFingerprint(options.config)
    : undefined;
}

export function clearCurrentPluginMetadataSnapshot(): void {
  currentPluginMetadataSnapshot = undefined;
  currentPluginMetadataSnapshotConfigFingerprint = undefined;
}

export function getCurrentPluginMetadataSnapshot(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
  } = {},
): PluginMetadataSnapshot | undefined {
  const snapshot = currentPluginMetadataSnapshot;
  if (!snapshot) {
    return undefined;
  }
  if (
    params.config &&
    snapshot.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
  ) {
    return undefined;
  }
  if (
    params.config &&
    currentPluginMetadataSnapshotConfigFingerprint &&
    currentPluginMetadataSnapshotConfigFingerprint !==
      resolvePluginMetadataSnapshotConfigFingerprint(params.config)
  ) {
    return undefined;
  }
  if (snapshot.workspaceDir !== undefined && params.workspaceDir === undefined) {
    return undefined;
  }
  if (
    params.workspaceDir !== undefined &&
    (snapshot.workspaceDir ?? "") !== (params.workspaceDir ?? "")
  ) {
    return undefined;
  }
  return snapshot;
}
