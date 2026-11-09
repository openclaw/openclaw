import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getPluginInstallRecordMapEntry } from "../config/plugin-install-record-map.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { resolveActivePluginInstallRoots } from "./install-root-context.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { updateInstalledPluginSourceSnapshots } from "./installed-plugin-index-store-write.js";
import { readCurrentInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index-types.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
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
  createPluginSnapshotBackgroundWork,
  type PluginSnapshotScrubOutcome,
} from "./plugin-source-snapshot-scrub.js";
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
  const expected = getPluginInstallRecordMapEntry(record.sourceSnapshotDigests, params.pluginId);
  const optionsDigest = pluginSourceSnapshotOptionsDigest();
  let freshCapture = false;
  let authorityFailure: Error | undefined;
  const matchesInstallation = (descriptor: PluginSourceSnapshotDescriptor) =>
    descriptor.formatVersion === 2 &&
    expected !== undefined &&
    descriptor.installRecordHash === selected.installRecordHash &&
    descriptor.contentDigest === expected.contentDigest &&
    descriptor.dependencyClosureDigest === expected.dependencyClosureDigest &&
    descriptor.buildResolutionDigest === optionsDigest &&
    descriptor.packageIntegrity === (record.integrity ?? record.npmIntegrity);
  const assertCurrent = async () => {
    if (authorityFailure) {
      throw authorityFailure;
    }
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
      current.installRecordHash !== selected.installRecordHash
    ) {
      throw new PluginInventoryRetiredError();
    }
    if (!isDeepStrictEqual(current.sourceSnapshot, selected.sourceSnapshot)) {
      const sibling = PluginSourceSnapshotDescriptorSchema.safeParse(current.sourceSnapshot);
      if (
        !freshCapture ||
        selected.sourceSnapshot !== undefined ||
        !sibling.success ||
        !matchesInstallation(sibling.data)
      ) {
        throw new PluginInventoryRetiredError();
      }
      // A concurrent first start can publish the same sealed installation. Keep this
      // fresh capture; the next start independently verifies the winning artifact.
      selected = current;
    }
  };
  let prepared: PreparedPluginGenerationArtifact | undefined;
  let publish: ((signal: AbortSignal) => Promise<void>) | undefined;
  if (Object.hasOwn(selected, "sourceSnapshot")) {
    try {
      const parsed = PluginSourceSnapshotDescriptorSchema.safeParse(selected.sourceSnapshot);
      if (parsed.success && parsed.data.formatVersion !== 2) {
        throw new PluginSourceSnapshotIncompatibleError(
          parsed.data.artifact.path,
          parsed.data.formatVersion,
        );
      }
      if (!parsed.success || !matchesInstallation(parsed.data)) {
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
      freshCapture = true;
      prepared = await preparePluginGenerationArtifact(params);
      await assertCurrent();
      // Publication benefits the next start. Registration and its original capture
      // finish before the post-ready owner dispatches this optional work.
      if (expected && !isArtifactPreservingStateRead() && !selected.sourceSnapshot) {
        publish = async (signal) => {
          await assertCurrent();
          signal.throwIfAborted();
          if (selected.sourceSnapshot) {
            return;
          }
          const snapshot = await preparePluginSourceSnapshot({
            rootDir: params.rootDir,
            stateDir,
            shared: true,
            backgroundSignal: signal,
          });
          let candidate: Omit<PluginSourceSnapshotDescriptor, "installedRevision"> | undefined;
          try {
            signal.throwIfAborted();
            await assertCurrent();
            if (
              !selected.sourceSnapshot &&
              snapshot.contentDigest === expected.contentDigest &&
              snapshot.dependencyClosureDigest === expected.dependencyClosureDigest
            ) {
              const descriptor = (candidate = await snapshot.publish({
                installRecordHash: selected.installRecordHash!,
                ...expected,
                buildResolutionDigest: optionsDigest,
                packageIntegrity: record.integrity ?? record.npmIntegrity,
              }));
              signal.throwIfAborted();
              await assertCurrent();
              if (selected.sourceSnapshot) {
                return;
              }
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
                // The index owner arbitrates concurrent publishers atomically.
                await assertCurrent();
                if (!selected.sourceSnapshot) {
                  throw new PluginInventoryRetiredError();
                }
                return;
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
        };
      }
    }
    const artifact = prepared.artifact;
    const scrub = prepared.startScrub;
    const cancelScrub = prepared.cancelScrub;
    let onBackgroundFailure: (error: unknown) => Promise<void> = async () => {};
    const publishSource = publish;
    // Keep the selected source owners without retaining startup work or its accounting.
    const runInPreparationContext = publishSource
      ? runOutsideAsyncWorkScope(() =>
          withPluginGenerationMetrics(createPluginGenerationMetrics(), () =>
            AsyncLocalStorage.snapshot(),
          ),
        )
      : undefined;
    const publication =
      publishSource &&
      runInPreparationContext &&
      createPluginSnapshotBackgroundWork((signal) =>
        runInPreparationContext(async (): Promise<PluginSnapshotScrubOutcome> => {
          try {
            await publishSource(signal);
            return { status: "passed" };
          } catch (error) {
            if (signal.aborted) {
              return { status: "cancelled" };
            }
            let failure = error;
            let current = true;
            try {
              await assertCurrent();
            } catch (currentError) {
              current = false;
              failure = currentError;
            }
            if (!current || failure instanceof PluginInventoryRetiredError) {
              const retired =
                failure instanceof PluginInventoryRetiredError
                  ? failure
                  : new PluginInventoryRetiredError();
              authorityFailure = retired;
              params.onWarning(
                `Plugin source snapshot publication lost installation authority for ${params.rootDir}. Retiring this runtime instance.`,
                params.rootDir,
              );
              await onBackgroundFailure(retired);
              return { status: "failed", error: retired };
            }
            params.onWarning(
              `Plugin source snapshot publication failed for ${params.rootDir}: ${String(failure)}. Continuing with the prepared guarded capture.`,
              params.rootDir,
            );
            return { status: "failed", error: failure };
          }
        }),
      );
    const cancelBackground = async () => {
      try {
        await publication?.cancel();
      } finally {
        await cancelScrub?.();
      }
    };
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
    const disposeAsync = artifact.disposeAsync.bind(artifact);
    let disposal: Promise<void> | undefined;
    artifact.disposeAsync = () =>
      (disposal ??= (async () => {
        try {
          await cancelBackground();
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
      })());
    artifact.dispose = () => {
      // Cancellation is synchronous; physical cleanup joins the active worker RPC.
      void artifact.disposeAsync().catch((error: unknown) => process.emitWarning(String(error)));
    };
    return {
      ...prepared,
      assertCurrent,
      startScrub: scrub
        ? () => scrub(invalidate)
        : publication
          ? (onFailure) => {
              onBackgroundFailure = onFailure;
              return publication.start();
            }
          : undefined,
      cancelScrub: cancelBackground,
      onInvalidSnapshot: invalidate,
    };
  } catch (error) {
    await prepared?.artifact.disposeAsync();
    throw error;
  }
}
