import {
  createPluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { throwSettledAggregate } from "../infra/error-graph-internal.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { normalizeInstallRecordMap } from "./installed-plugin-index-install-records.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import {
  preparePluginSourceSnapshot,
  type PreparedPluginSourceSnapshot,
} from "./plugin-generation-worker.js";
import { collectPluginSourceSnapshots } from "./plugin-source-snapshot-artifact.js";
import {
  isManagedPluginSnapshotSource,
  pluginSourceSnapshotOptionsDigest,
} from "./plugin-source-snapshot-options.js";
import type { PluginSourceSnapshotPublication } from "./plugin-source-snapshot.types.js";

/** The install lease owns all tentative artifacts until config/index settlement. */
export async function preparePluginInstallSourceSnapshots(params: {
  installOwner: string;
  installRecord: PluginInstallRecord;
  manifests: readonly Pick<PluginManifestRecord, "id" | "rootDir" | "origin" | "format">[];
  stateDir: string;
  assertCurrent: () => void | Promise<void>;
  assertCleanupOwned: () => void | Promise<void>;
}) {
  const prepared = new Map<string, PreparedPluginSourceSnapshot>();
  const sourceSnapshots: PluginSourceSnapshotPublication[] = [];
  const dispose = async () => {
    const results = await Promise.allSettled(
      [...prepared.values()].map((entry) => entry.disposeAsync()),
    );
    prepared.clear();
    throwSettledAggregate(results, "Plugin source snapshot preparation cleanup failed");
  };
  try {
    delete params.installRecord.sourceSnapshotDigests;
    if (isManagedPluginSnapshotSource(params.installRecord)) {
      const digests =
        createPluginInstallRecordMap<
          NonNullable<PluginInstallRecord["sourceSnapshotDigests"]>[string]
        >();
      for (const manifest of params.manifests) {
        if (manifest.origin === "bundled" || manifest.format === "bundle") {
          continue;
        }
        await params.assertCurrent();
        const capture = await preparePluginSourceSnapshot({
          rootDir: manifest.rootDir,
          stateDir: params.stateDir,
        });
        prepared.set(manifest.id, capture);
        await params.assertCurrent();
        setPluginInstallRecordMapEntry(digests, manifest.id, {
          contentDigest: capture.contentDigest,
          dependencyClosureDigest: capture.dependencyClosureDigest,
        });
      }
      if (prepared.size) {
        params.installRecord.sourceSnapshotDigests = digests;
      }
      const installRecord = normalizeInstallRecordMap(
        Object.fromEntries([[params.installOwner, params.installRecord]]),
      )[params.installOwner]!;
      const installRecordHash = hashJson(installRecord);
      const buildResolutionDigest = pluginSourceSnapshotOptionsDigest();
      for (const manifest of params.manifests) {
        const capture = prepared.get(manifest.id);
        if (!capture) {
          continue;
        }
        await params.assertCurrent();
        const descriptor = await capture.publish({
          installRecordHash,
          contentDigest: capture.contentDigest,
          dependencyClosureDigest: capture.dependencyClosureDigest,
          buildResolutionDigest,
          packageIntegrity: installRecord.integrity ?? installRecord.npmIntegrity,
        });
        // The lease must own cleanup before any post-publication authority check can fail.
        sourceSnapshots.push({
          pluginId: manifest.id,
          installOwner: params.installOwner,
          rootDir: manifest.rootDir,
          descriptor,
        });
        await params.assertCurrent();
      }
    }
    return { sourceSnapshots, [Symbol.asyncDispose]: dispose };
  } catch (error) {
    const failures = [error];
    try {
      await dispose();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await collectPluginSourceSnapshots({
        stateDir: params.stateDir,
        retiredSnapshots: sourceSnapshots.map((entry) => entry.descriptor),
        retainedPaths: new Set(),
        assertCurrent: params.assertCleanupOwned,
      });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Plugin snapshot preparation and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}
