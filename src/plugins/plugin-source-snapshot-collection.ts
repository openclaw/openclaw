import { isDeepStrictEqual } from "node:util";
import { canCollectPluginSourceSnapshots } from "../infra/update-run-recovery-store.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { updateInstalledPluginSourceSnapshots } from "./installed-plugin-index-store-write.js";
import { readCurrentInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { updatePluginSnapshotCandidates } from "./installed-plugin-snapshot-candidates.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";
import { collectPluginSourceSnapshots } from "./plugin-source-snapshot-artifact.js";
import {
  PluginSourceSnapshotDescriptorSchema,
  pluginSourceSnapshotArtifactPath,
  type PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

/** Current reachability and pending rollback belong to the lifecycle owner; readers hold tokens. */
export async function collectInstalledPluginSourceSnapshots(
  stateDir: string,
  unpublished: readonly Omit<PluginSourceSnapshotDescriptor, "installedRevision">[] = [],
): Promise<void> {
  if (isArtifactPreservingStateRead()) {
    return;
  }
  try {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await withPluginLifecycleLeaseAsync({ env }, async (lease) => {
      const candidates = await updatePluginSnapshotCandidates({
        stateDir,
        lease,
        operation: "read",
      });
      let index = await readCurrentInstalledPluginIndex({
        stateDir,
        requireValidIfPresent: true,
      });
      await lease.assertOwned();
      if (!index && unpublished.length === 0 && candidates.length === 0) {
        return;
      }
      if (index && unpublished.length) {
        const knownPaths = new Set(
          [
            ...index.plugins.map((entry) => entry.sourceSnapshot),
            ...(index.retiredSourceSnapshots ?? []),
          ].map(pluginSourceSnapshotArtifactPath),
        );
        const unrecorded = unpublished.filter((entry) => !knownPaths.has(entry.artifact.path));
        if (unrecorded.length) {
          const recorded = await updateInstalledPluginSourceSnapshots({
            env,
            lease,
            sourceSnapshotRetirements: unrecorded,
          });
          if (!recorded) {
            throw new Error(
              "Installed plugin index disappeared before retaining snapshot cleanup authority",
            );
          }
          index = recorded.index;
        }
      }
      const allowed = await canCollectPluginSourceSnapshots({ env });
      await lease.assertOwned();
      // With no index, caller-owned candidates were never published and cannot be rollback roots.
      if (!allowed) {
        return;
      }
      const retainedPaths = new Set(
        (index?.plugins ?? []).flatMap((entry) => {
          const artifactPath = pluginSourceSnapshotArtifactPath(entry.sourceSnapshot);
          return artifactPath ? [artifactPath] : [];
        }),
      );
      const retiredSnapshots = (index?.retiredSourceSnapshots ?? []).flatMap((snapshot) => {
        const parsed = PluginSourceSnapshotDescriptorSchema.safeParse(snapshot);
        if (parsed.success) {
          return [parsed.data];
        }
        process.emitWarning(
          `Plugin source snapshot retirement retains malformed descriptor at ${pluginSourceSnapshotArtifactPath(snapshot) ?? stateDir}`,
        );
        return [];
      });
      const result = await collectPluginSourceSnapshots({
        stateDir,
        retainedPaths,
        retiredSnapshots: [...retiredSnapshots, ...candidates, ...(!index ? unpublished : [])],
        assertCurrent: lease.assertOwned,
      });
      for (const warning of result.warnings) {
        process.emitWarning(warning);
      }
      const removedCandidates = candidates.filter((candidate) =>
        result.removedSnapshots.some((removed) => isDeepStrictEqual(candidate, removed)),
      );
      if (removedCandidates.length) {
        await updatePluginSnapshotCandidates({
          stateDir,
          lease,
          operation: "release",
          candidates: removedCandidates,
        });
      }
      const removedStored = retiredSnapshots.filter((snapshot) =>
        result.removedSnapshots.some((removed) => isDeepStrictEqual(snapshot, removed)),
      );
      if (removedStored.length) {
        await updateInstalledPluginSourceSnapshots({
          env,
          lease,
          collectedSourceSnapshots: removedStored,
        });
      }
    });
  } catch (error) {
    // Failed collection retains bytes; it must not hide an install or runtime result.
    process.emitWarning(`Plugin source snapshot collection deferred: ${String(error)}`);
  }
}
