let currentPluginMetadataSnapshot: unknown;
let currentPluginMetadataSnapshotConfigFingerprint: string | undefined;
const transientPluginMetadataSnapshotClearers = new Set<() => void>();

export function registerTransientPluginMetadataSnapshotClearer(clearer: () => void): void {
  transientPluginMetadataSnapshotClearers.add(clearer);
}

export function setCurrentPluginMetadataSnapshotState(
  snapshot: unknown,
  configFingerprint: string | undefined,
): void {
  currentPluginMetadataSnapshot = snapshot;
  currentPluginMetadataSnapshotConfigFingerprint = snapshot ? configFingerprint : undefined;
}

export function clearCurrentPluginMetadataSnapshotState(): void {
  currentPluginMetadataSnapshot = undefined;
  currentPluginMetadataSnapshotConfigFingerprint = undefined;
  for (const clearer of transientPluginMetadataSnapshotClearers) {
    clearer();
  }
}

export function getCurrentPluginMetadataSnapshotState(): {
  snapshot: unknown;
  configFingerprint: string | undefined;
} {
  return {
    snapshot: currentPluginMetadataSnapshot,
    configFingerprint: currentPluginMetadataSnapshotConfigFingerprint,
  };
}
