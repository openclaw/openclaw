import { isDeepStrictEqual } from "node:util";
import { getPluginInstallRecordMapEntry } from "../config/plugin-install-record-map.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRecord,
} from "./installed-plugin-index-types.js";
import {
  PluginSourceSnapshotDescriptorSchema,
  pluginSourceSnapshotArtifactPath,
  type PluginSourceSnapshotChanges,
  type PluginSourceSnapshotIndexChange,
  type PluginSourceSnapshotIndexState,
  type PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

/** Keep original artifact authority after its install row disappears or is rolled back. */
export function reconcileRetiredPluginSourceSnapshots(
  previous: InstalledPluginIndex | null,
  current: InstalledPluginIndex,
): void {
  const live = current.plugins
    .filter((plugin) => Object.hasOwn(plugin, "sourceSnapshot"))
    .map((plugin) => plugin.sourceSnapshot);
  const candidates = [
    ...(previous?.retiredSourceSnapshots ?? []),
    ...(current.retiredSourceSnapshots ?? []),
    ...(previous?.plugins
      .filter((plugin) => Object.hasOwn(plugin, "sourceSnapshot"))
      .map((plugin) => plugin.sourceSnapshot) ?? []),
  ];
  const retired: unknown[] = [];
  for (const candidate of candidates) {
    if (
      !live.some((snapshot) => isDeepStrictEqual(snapshot, candidate)) &&
      !retired.some((snapshot) => isDeepStrictEqual(snapshot, candidate))
    ) {
      retired.push(candidate);
    }
  }
  if (retired.length) {
    current.retiredSourceSnapshots = retired;
  } else {
    delete current.retiredSourceSnapshots;
  }
}

/** Only acknowledged removal of the exact retired descriptor releases its durable authority. */
export function forgetCollectedPluginSourceSnapshots(
  index: InstalledPluginIndex,
  collected: readonly PluginSourceSnapshotDescriptor[],
): void {
  for (const snapshot of collected) {
    if (index.plugins.some((plugin) => isDeepStrictEqual(plugin.sourceSnapshot, snapshot))) {
      throw new Error("Cannot acknowledge collection of an active plugin source snapshot");
    }
  }
  const retained = index.retiredSourceSnapshots?.filter(
    (snapshot) => !collected.some((removed) => isDeepStrictEqual(snapshot, removed)),
  );
  if (retained?.length) {
    index.retiredSourceSnapshots = retained;
  } else {
    delete index.retiredSourceSnapshots;
  }
}

function snapshotState(
  plugin: InstalledPluginIndexRecord | undefined,
): PluginSourceSnapshotIndexState | null {
  if (!plugin) {
    return null;
  }
  const installOwner = resolveInstalledPluginIndexInstallOwner(plugin);
  return {
    ...(installOwner ? { installOwner } : {}),
    rootDir: plugin.rootDir,
    ...(plugin.installRecordHash ? { installRecordHash: plugin.installRecordHash } : {}),
    ...(Object.hasOwn(plugin, "sourceSnapshot") ? { sourceSnapshot: plugin.sourceSnapshot } : {}),
    ...(plugin.sourceSnapshotWarning
      ? { sourceSnapshotWarning: plugin.sourceSnapshotWarning }
      : {}),
  };
}

/** Persist exact before/after metadata, including malformed named snapshots, for cohort rollback. */
export function diffPluginSourceSnapshotStates(
  previous: InstalledPluginIndex | null,
  current: InstalledPluginIndex,
): PluginSourceSnapshotIndexChange[] {
  const before = new Map(previous?.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const after = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((pluginId) => {
    const prior = snapshotState(before.get(pluginId));
    const next = snapshotState(after.get(pluginId));
    const named = [prior, next].some(
      (state) => state && (Object.hasOwn(state, "sourceSnapshot") || state.sourceSnapshotWarning),
    );
    return named && !isDeepStrictEqual(prior, next)
      ? [{ pluginId, before: prior, after: next }]
      : [];
  });
}

/** Repeated publications keep the first generation and reject an intervening unrelated writer. */
export function foldPluginSourceSnapshotChanges(
  changes: readonly PluginSourceSnapshotIndexChange[],
): PluginSourceSnapshotIndexChange[] {
  const folded = new Map<string, PluginSourceSnapshotIndexChange>();
  for (const change of changes) {
    const prior = folded.get(change.pluginId);
    if (prior && !isDeepStrictEqual(prior.after, change.before)) {
      throw new Error(
        `Plugin ${change.pluginId} source snapshot changed between update publications.`,
      );
    }
    folded.set(change.pluginId, { ...change, before: prior ? prior.before : change.before });
  }
  return [...folded.values()];
}

/** Restore only a cohort's exact predecessor; a later snapshot publication keeps its own state. */
export function restorePluginSourceSnapshotStates(
  previous: InstalledPluginIndex | null,
  current: InstalledPluginIndex,
  changes: readonly PluginSourceSnapshotIndexChange[],
): void {
  const previousById = new Map(previous?.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const currentById = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const change of changes) {
    const retained = snapshotState(previousById.get(change.pluginId));
    if (!isDeepStrictEqual(retained, change.after) && !isDeepStrictEqual(retained, change.before)) {
      throw new Error(
        `Plugin ${change.pluginId} source snapshot changed after the update; recovery preserved it.`,
      );
    }
    const target = currentById.get(change.pluginId);
    const before = change.before;
    if (!before) {
      if (target) {
        throw new Error(
          `Plugin ${change.pluginId} source snapshot restoration expected no plugin.`,
        );
      }
      continue;
    }
    if (
      !target ||
      target.rootDir !== before.rootDir ||
      target.installRecordHash !== before.installRecordHash ||
      resolveInstalledPluginIndexInstallOwner(target) !== before.installOwner
    ) {
      throw new Error(
        `Plugin ${change.pluginId} source snapshot restoration no longer matches its install record.`,
      );
    }
    const descriptor = PluginSourceSnapshotDescriptorSchema.safeParse(before.sourceSnapshot);
    if (descriptor.success) {
      const install = before.installOwner ? current.installRecords[before.installOwner] : undefined;
      const digests = getPluginInstallRecordMapEntry(
        install?.sourceSnapshotDigests,
        change.pluginId,
      );
      if (
        !install ||
        hashJson(install) !== before.installRecordHash ||
        descriptor.data.installRecordHash !== before.installRecordHash ||
        descriptor.data.packageIntegrity !== (install.integrity ?? install.npmIntegrity) ||
        descriptor.data.contentDigest !== digests?.contentDigest ||
        descriptor.data.dependencyClosureDigest !== digests?.dependencyClosureDigest
      ) {
        throw new Error(
          `Plugin ${change.pluginId} source snapshot restoration differs from its install record.`,
        );
      }
    }
    delete target.sourceSnapshot;
    delete target.sourceSnapshotWarning;
    if (Object.hasOwn(before, "sourceSnapshot")) {
      target.sourceSnapshot = before.sourceSnapshot;
    }
    if (before.sourceSnapshotWarning) {
      target.sourceSnapshotWarning = before.sourceSnapshotWarning;
    }
  }
  projectPluginSourceSnapshotWarnings(current);
}

function hasSameInstallOwner(
  prior: InstalledPluginIndexRecord,
  current: InstalledPluginIndexRecord,
): boolean {
  const owner = resolveInstalledPluginIndexInstallOwner(current);
  return Boolean(
    owner &&
    resolveInstalledPluginIndexInstallOwner(prior) === owner &&
    current.installRecordHash &&
    prior.installRecordHash === current.installRecordHash &&
    prior.rootDir === current.rootDir,
  );
}

function projectPluginSourceSnapshotWarnings(index: InstalledPluginIndex): void {
  index.diagnostics = [
    ...index.diagnostics.filter(
      (diagnostic) => diagnostic.code !== "plugin-source-snapshot-invalid",
    ),
    ...index.plugins.flatMap((plugin) =>
      plugin.sourceSnapshotWarning
        ? [
            {
              level: "warn" as const,
              pluginId: plugin.pluginId,
              source: plugin.sourceSnapshotWarning.artifactPath,
              code: "plugin-source-snapshot-invalid" as const,
              message: `Source snapshot ${plugin.sourceSnapshotWarning.artifactPath}: ${plugin.sourceSnapshotWarning.message}`,
            },
          ]
        : [],
    ),
  ];
}

/** Refreshes retain snapshots, including malformed named snapshots, only for their exact owner. */
export function preservePluginSourceSnapshots(
  previous: InstalledPluginIndex | null,
  current: InstalledPluginIndex,
): void {
  const records = new Map(previous?.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const plugin of current.plugins) {
    const prior = records.get(plugin.pluginId);
    delete plugin.sourceSnapshot;
    delete plugin.sourceSnapshotWarning;
    if (prior && hasSameInstallOwner(prior, plugin)) {
      if (Object.hasOwn(prior, "sourceSnapshot")) {
        plugin.sourceSnapshot = prior.sourceSnapshot;
      }
      if (prior.sourceSnapshotWarning) {
        plugin.sourceSnapshotWarning = prior.sourceSnapshotWarning;
      }
    }
  }
  projectPluginSourceSnapshotWarnings(current);
}

/** Called only inside the index owner's transaction after the authoritative predecessor read. */
export function applyPluginSourceSnapshotChanges(
  index: InstalledPluginIndex,
  revision: number,
  changes: PluginSourceSnapshotChanges,
  retainWarnings = false,
): void {
  const records = new Map(index.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const changed = new Set<string>();
  const takeRecord = (
    pluginId: string,
    installOwner: string,
    rootDir: string,
    installRecordHash: string,
  ) => {
    if (changed.has(pluginId)) {
      throw new Error(`Duplicate source snapshot publication for plugin ${pluginId}`);
    }
    changed.add(pluginId);
    const record = records.get(pluginId);
    const install = index.installRecords[installOwner];
    if (
      !installOwner ||
      !installRecordHash ||
      !install ||
      hashJson(install) !== installRecordHash ||
      !record ||
      resolveInstalledPluginIndexInstallOwner(record) !== installOwner ||
      record.rootDir !== rootDir ||
      record.installRecordHash !== installRecordHash
    ) {
      throw new Error(`Source snapshot no longer matches installed plugin ${pluginId}`);
    }
    return record;
  };
  for (const removal of changes.sourceSnapshotRemovals ?? []) {
    const record = takeRecord(
      removal.pluginId,
      removal.installOwner,
      removal.rootDir,
      removal.installRecordHash,
    );
    if (
      !Object.hasOwn(record, "sourceSnapshot") ||
      !isDeepStrictEqual(record.sourceSnapshot, removal.expectedSnapshot)
    ) {
      throw new Error(`Source snapshot changed before invalidating plugin ${removal.pluginId}`);
    }
    delete record.sourceSnapshot;
    record.sourceSnapshotWarning = removal.warning;
  }
  for (const publication of changes.sourceSnapshots ?? []) {
    const descriptor = PluginSourceSnapshotDescriptorSchema.parse({
      ...publication.descriptor,
      installedRevision: revision,
    });
    const record = takeRecord(
      publication.pluginId,
      publication.installOwner,
      publication.rootDir,
      descriptor.installRecordHash,
    );
    const install = index.installRecords[publication.installOwner];
    if ((install?.integrity ?? install?.npmIntegrity) !== descriptor.packageIntegrity) {
      throw new Error(
        `Source snapshot integrity differs from installed plugin ${publication.pluginId}`,
      );
    }
    const digests = getPluginInstallRecordMapEntry(
      install?.sourceSnapshotDigests,
      publication.pluginId,
    );
    if (
      !digests ||
      digests.contentDigest !== descriptor.contentDigest ||
      digests.dependencyClosureDigest !== descriptor.dependencyClosureDigest
    ) {
      throw new Error(
        `Source snapshot content differs from installed plugin ${publication.pluginId}`,
      );
    }
    record.sourceSnapshot = descriptor;
    if (!retainWarnings) {
      delete record.sourceSnapshotWarning;
    }
  }
  for (const candidate of changes.sourceSnapshotRetirements ?? []) {
    const known = [
      ...index.plugins.map((plugin) => plugin.sourceSnapshot),
      ...(index.retiredSourceSnapshots ?? []),
    ];
    if (
      known.some((entry) => pluginSourceSnapshotArtifactPath(entry) === candidate.artifact.path)
    ) {
      continue;
    }
    // Zero records an unpublished candidate, never a reusable installation revision.
    const descriptor = PluginSourceSnapshotDescriptorSchema.parse({
      ...candidate,
      installedRevision: 0,
    });
    index.retiredSourceSnapshots = [...(index.retiredSourceSnapshots ?? []), descriptor];
  }
  projectPluginSourceSnapshotWarnings(index);
}
