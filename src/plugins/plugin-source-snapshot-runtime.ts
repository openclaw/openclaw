import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getPluginInstallRecordMapEntry } from "../config/plugin-install-record-map.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { updateInstalledPluginSourceSnapshots } from "./installed-plugin-index-store-write.js";
import { readCurrentInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index-types.js";
import {
  preparePluginGenerationArtifact,
  preparePluginSourceSnapshot,
  type PreparedPluginGenerationArtifact,
} from "./plugin-generation-worker.js";
import { PluginInventoryRetiredError } from "./plugin-instance-error.js";
import {
  PluginSourceSnapshotValidationError,
  PluginSourceSnapshotIncompatibleError,
} from "./plugin-source-snapshot-artifact.js";
import { collectInstalledPluginSourceSnapshots } from "./plugin-source-snapshot-collection.js";
import {
  type ManagedPluginSnapshotIdentity,
  isManagedPluginSnapshotSource,
  pluginSourceSnapshotOptionsDigest,
} from "./plugin-source-snapshot-options.js";
import {
  PluginSourceSnapshotDescriptorSchema,
  pluginSourceSnapshotArtifactPath,
  type PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

/** Select only a current committed installation; metadata alone never authorizes persisted code. */
export async function prepareInstalledPluginGenerationArtifact(params: {
  installation: ManagedPluginSnapshotIdentity;
  pluginId: string;
  rootDir: string;
  source: string;
  standalone?: boolean;
  onWarning: (message: string, source: string) => void;
}): Promise<PreparedPluginGenerationArtifact & { assertCurrent(): Promise<void> }> {
  const stateDir = resolveActivePluginInstallRoots().stateDir;
  const index = await readCurrentInstalledPluginIndex({
    stateDir,
    artifactPreservingReadOnly: isArtifactPreservingStateRead(),
  });
  const row = index?.plugins.find(
    (entry) =>
      entry.pluginId === params.pluginId &&
      path.resolve(entry.rootDir) === path.resolve(params.rootDir),
  );
  const installOwner = row && resolveInstalledPluginIndexInstallOwner(row);
  const record = installOwner && index?.installRecords[installOwner];
  if (
    !row ||
    !installOwner ||
    !record ||
    !isManagedPluginSnapshotSource(record) ||
    !row.installRecordHash ||
    installOwner !== params.installation.installOwner ||
    row.installRecordHash !== params.installation.installRecordHash ||
    hashJson(record) !== row.installRecordHash
  ) {
    throw new PluginInventoryRetiredError();
  }
  let selected: InstalledPluginIndexRecord = row;
  const assertCurrent = async () => {
    const current = (
      await readCurrentInstalledPluginIndex({
        stateDir,
        artifactPreservingReadOnly: isArtifactPreservingStateRead(),
      })
    )?.plugins.find((entry) => entry.pluginId === selected.pluginId);
    if (
      !current ||
      resolveInstalledPluginIndexInstallOwner(current) !== installOwner ||
      current.rootDir !== selected.rootDir ||
      current.installRecordHash !== selected.installRecordHash ||
      !isDeepStrictEqual(current.sourceSnapshot, selected.sourceSnapshot)
    ) {
      throw new PluginInventoryRetiredError();
    }
  };
  const expected = getPluginInstallRecordMapEntry(record.sourceSnapshotDigests, params.pluginId);
  const optionsDigest = pluginSourceSnapshotOptionsDigest();
  let prepared: PreparedPluginGenerationArtifact | undefined;
  if (Object.hasOwn(selected, "sourceSnapshot")) {
    try {
      const parsed = PluginSourceSnapshotDescriptorSchema.safeParse(selected.sourceSnapshot);
      if (parsed.success && parsed.data.formatVersion !== 2) {
        throw new PluginSourceSnapshotIncompatibleError(
          parsed.data.artifact.path,
          parsed.data.formatVersion,
        );
      }
      if (
        !parsed.success ||
        !expected ||
        parsed.data.installRecordHash !== selected.installRecordHash ||
        parsed.data.contentDigest !== expected.contentDigest ||
        parsed.data.dependencyClosureDigest !== expected.dependencyClosureDigest ||
        parsed.data.buildResolutionDigest !== optionsDigest ||
        parsed.data.packageIntegrity !== (record.integrity ?? record.npmIntegrity)
      ) {
        throw new PluginSourceSnapshotValidationError(
          pluginSourceSnapshotArtifactPath(selected.sourceSnapshot) ?? selected.rootDir,
          "snapshot binding does not match this installation and runtime",
        );
      }
      prepared = await preparePluginGenerationArtifact({
        ...params,
        sourceSnapshot: { descriptor: parsed.data, stateDir, shared: true },
      });
      await assertCurrent();
    } catch (error) {
      if (prepared) {
        await prepared.artifact.disposeAsync();
        prepared = undefined;
      }
      const obsolete = error instanceof PluginSourceSnapshotIncompatibleError;
      if (!(error instanceof PluginSourceSnapshotValidationError) && !obsolete) {
        throw error;
      }
      const message = `${error.message}. Invalidating this snapshot and using a fresh guarded capture of ${params.rootDir}.`;
      if (!obsolete) {
        params.onWarning(message, error.artifactPath);
      }
      if (!isArtifactPreservingStateRead()) {
        const retired = await updateInstalledPluginSourceSnapshots({
          stateDir,
          sourceSnapshotRemovals: [
            {
              pluginId: selected.pluginId,
              installOwner,
              rootDir: selected.rootDir,
              installRecordHash: selected.installRecordHash!,
              expectedSnapshot: selected.sourceSnapshot,
              ...(obsolete ? {} : { warning: { artifactPath: error.artifactPath, message } }),
            },
          ],
        });
        if (!retired) {
          throw new PluginInventoryRetiredError();
        }
        selected = retired.index.plugins.find((entry) => entry.pluginId === params.pluginId)!;
      }
    }
  }
  try {
    if (!prepared) {
      prepared = await preparePluginGenerationArtifact(params);
      await assertCurrent();
      // Old records without a content+closure digest deliberately remain on fresh capture.
      if (expected && !isArtifactPreservingStateRead()) {
        try {
          const snapshot = await preparePluginSourceSnapshot({
            rootDir: params.rootDir,
            stateDir,
            shared: true,
          });
          let candidate: Omit<PluginSourceSnapshotDescriptor, "installedRevision"> | undefined;
          try {
            await assertCurrent();
            if (
              snapshot.contentDigest === expected.contentDigest &&
              snapshot.dependencyClosureDigest === expected.dependencyClosureDigest
            ) {
              const descriptor = (candidate = await snapshot.publish({
                installRecordHash: selected.installRecordHash!,
                ...expected,
                buildResolutionDigest: optionsDigest,
                packageIntegrity: record.integrity ?? record.npmIntegrity,
              }));
              await assertCurrent();
              const published = await updateInstalledPluginSourceSnapshots({
                stateDir,
                sourceSnapshots: [
                  {
                    pluginId: selected.pluginId,
                    installOwner,
                    rootDir: selected.rootDir,
                    descriptor,
                  },
                ],
              });
              if (!published) {
                throw new PluginInventoryRetiredError();
              }
              selected = published.index.plugins.find(
                (entry) => entry.pluginId === params.pluginId,
              )!;
              // The write reply can retain optional undefined fields that SQLite JSON omits.
              // oxlint-disable-next-line unicorn/prefer-structured-clone -- Match persisted JSON by dropping undefined fields.
              const storedSnapshot: unknown = JSON.parse(JSON.stringify(selected.sourceSnapshot));
              selected = { ...selected, sourceSnapshot: storedSnapshot };
            }
          } finally {
            try {
              await snapshot.disposeAsync();
            } finally {
              if (candidate) {
                await collectInstalledPluginSourceSnapshots(stateDir, [candidate]);
              }
            }
          }
        } catch (error) {
          if (error instanceof PluginInventoryRetiredError) {
            throw error;
          }
          // Publication benefits the next start; retain this capture only under current authority.
          await assertCurrent();
          params.onWarning(
            `Plugin source snapshot publication failed for ${params.rootDir}: ${String(error)}. Continuing with the prepared guarded capture.`,
            params.rootDir,
          );
        }
      }
    }
    const artifact = prepared.artifact;
    const scrub = prepared.startScrub;
    const cancelScrub = prepared.cancelScrub;
    const observedSnapshot = selected.sourceSnapshot;
    let retirement: Promise<void> | undefined;
    const invalidate = (error: unknown): Promise<void> => {
      // All readers of this admission report to one retirement, including deferred loads.
      return (retirement ??= retireInvalid(error).catch((failure: unknown) => {
        process.emitWarning(`Plugin source snapshot retirement failed: ${String(failure)}`);
      }));
    };
    const retireInvalid = async (error: unknown) => {
      const artifactPath = pluginSourceSnapshotArtifactPath(observedSnapshot) ?? params.rootDir;
      const detail =
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : String(error);
      const message = `Plugin source snapshot validation failed at ${artifactPath}: ${detail}. Retiring this snapshot; the current process will keep running and the next start will capture source again.`;
      params.onWarning(message, artifactPath);
      if (!isArtifactPreservingStateRead()) {
        await updateInstalledPluginSourceSnapshots({
          stateDir,
          sourceSnapshotRemovals: [
            {
              pluginId: selected.pluginId,
              installOwner,
              rootDir: selected.rootDir,
              installRecordHash: selected.installRecordHash!,
              expectedSnapshot: observedSnapshot,
              warning: { artifactPath, message },
            },
          ],
        });
      }
    };
    const dispose = artifact.dispose.bind(artifact);
    const disposeAsync = artifact.disposeAsync.bind(artifact);
    artifact.dispose = () => {
      dispose();
      void collectInstalledPluginSourceSnapshots(stateDir).catch((error: unknown) =>
        process.emitWarning(String(error)),
      );
    };
    artifact.disposeAsync = async () => {
      try {
        await cancelScrub?.();
      } finally {
        try {
          await retirement;
        } finally {
          try {
            await disposeAsync();
          } finally {
            await collectInstalledPluginSourceSnapshots(stateDir);
          }
        }
      }
    };
    return {
      ...prepared,
      assertCurrent,
      startScrub: scrub && (() => scrub(invalidate)),
      onInvalidSnapshot: invalidate,
    };
  } catch (error) {
    await prepared?.artifact.disposeAsync();
    throw error;
  }
}
