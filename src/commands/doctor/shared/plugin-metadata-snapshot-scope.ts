import { resolveConfigWidePluginManifestRegistry } from "../../../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  withPluginMetadataSnapshotScope,
  type PluginMetadataSnapshotScopeRunner,
} from "../../../plugins/current-plugin-metadata-snapshot.js";
import { withDeferredPluginDoctorMigrations } from "../../../plugins/doctor-contract-registry.js";
import {
  createPluginCache,
  getPluginMetadataSnapshotCache,
  withPluginCache,
} from "../../../plugins/plugin-cache.js";
import {
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  rebasePluginMetadataSnapshotManifestRegistry,
  type PluginMetadataSnapshot,
} from "../../../plugins/plugin-metadata-snapshot.js";

export type DoctorPluginMetadataSnapshotState = {
  current?: PluginMetadataSnapshot;
  inventoryChanged?: boolean;
};

type DoctorPluginMetadataSnapshotScope = {
  run: PluginMetadataSnapshotScopeRunner;
  invalidate: () => void;
};

const configWideDoctorSnapshots = new WeakSet<PluginMetadataSnapshot>();

/** Aligns Doctor's immutable snapshot view with config-wide agent workspace discovery. */
export function resolveConfigWideDoctorPluginMetadataSnapshot(params: {
  snapshot: PluginMetadataSnapshot;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot {
  if (configWideDoctorSnapshots.has(params.snapshot)) {
    return params.snapshot;
  }
  const manifestRegistry = resolveConfigWidePluginManifestRegistry({
    config: params.config,
    env: params.env,
    // Doctor calls this after filesystem repairs; the process-current snapshot
    // may describe the pre-repair manifest and must not restore stale owners.
    allowCurrent: false,
  });
  const snapshot =
    manifestRegistry === params.snapshot.manifestRegistry
      ? params.snapshot
      : rebasePluginMetadataSnapshotManifestRegistry(params.snapshot, manifestRegistry);
  configWideDoctorSnapshots.add(snapshot);
  return snapshot;
}

/** Reuses one exact immutable plugin metadata generation per Doctor workspace. */
export function createDoctorPluginMetadataSnapshotScope(params: {
  getBaseSnapshot?: () => PluginMetadataSnapshot | undefined;
  env?: NodeJS.ProcessEnv;
  getDeferredPluginIds?: () => readonly string[];
}): DoctorPluginMetadataSnapshotScope {
  const env = params.env ?? process.env;
  const snapshotsByWorkspace = new Map<string | undefined, PluginMetadataSnapshot>();
  let currentBaseSnapshot: PluginMetadataSnapshot | undefined;
  let cache = createPluginCache();

  const refreshBaseSnapshot = () => {
    const nextBaseSnapshot = params.getBaseSnapshot?.();
    if (nextBaseSnapshot === currentBaseSnapshot) {
      return;
    }
    currentBaseSnapshot = nextBaseSnapshot;
    cache = nextBaseSnapshot
      ? getPluginMetadataSnapshotCache(nextBaseSnapshot)
      : createPluginCache();
    snapshotsByWorkspace.clear();
    if (nextBaseSnapshot && nextBaseSnapshot.pluginIds === undefined) {
      snapshotsByWorkspace.set(nextBaseSnapshot.workspaceDir, nextBaseSnapshot);
    }
  };

  const resolveSnapshot = (config: OpenClawConfig, workspaceDir: string | undefined) => {
    // An unqualified operation inherits compatible prepared context, not the system workspace.
    // Explicit workspace requests and narrower bases must retain their exact scope.
    const inheritedBase =
      workspaceDir === undefined && currentBaseSnapshot?.pluginIds === undefined
        ? currentBaseSnapshot
        : undefined;
    const current = [snapshotsByWorkspace.get(workspaceDir), inheritedBase].find(
      (snapshot) =>
        snapshot &&
        isPluginMetadataSnapshotCompatible({
          snapshot,
          config,
          env,
          workspaceDir: workspaceDir ?? snapshot.workspaceDir,
        }),
    );
    const snapshot = resolveConfigWideDoctorPluginMetadataSnapshot({
      snapshot:
        current ??
        loadPluginMetadataSnapshot({
          config,
          env,
          ...(workspaceDir ? { workspaceDir } : {}),
        }),
      config,
      env,
    });
    snapshotsByWorkspace.set(workspaceDir, snapshot);
    return snapshot;
  };

  const run: PluginMetadataSnapshotScopeRunner = (scope, operation) => {
    refreshBaseSnapshot();
    return withDeferredPluginDoctorMigrations(params.getDeferredPluginIds?.() ?? [], () =>
      withPluginCache(cache, () => {
        const snapshot = resolveSnapshot(scope.config, scope.workspaceDir);
        return withPluginMetadataSnapshotScope(snapshot, operation, {
          config: scope.config,
          env,
          ...(scope.workspaceDir ? { workspaceDir: scope.workspaceDir } : {}),
        });
      }),
    );
  };

  return {
    run,
    invalidate: () => {
      // Inventory repairs invalidate every derived workspace generation even
      // when updater preflight intentionally left the base snapshot absent.
      currentBaseSnapshot = undefined;
      snapshotsByWorkspace.clear();
      cache = createPluginCache();
    },
  };
}
