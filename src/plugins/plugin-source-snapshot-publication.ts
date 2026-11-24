import { updatePluginSnapshotCandidates } from "./installed-plugin-snapshot-candidates.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";
import type { stagePluginSourceSnapshot } from "./plugin-source-snapshot-artifact.js";
import type { PluginSourceSnapshotBinding } from "./plugin-source-snapshot.types.js";

type CapturedSource = {
  contentDigest: string;
  dependencyClosureDigest: string;
  dispose(): void;
  disposeAsync(): Promise<void>;
  stage(binding: PluginSourceSnapshotBinding): ReturnType<typeof stagePluginSourceSnapshot>;
};

/** Durable cleanup custody precedes final rename, under the installation's lifecycle lease. */
export function bindPluginSnapshotPublication(source: CapturedSource, stateDir: string) {
  return {
    contentDigest: source.contentDigest,
    dependencyClosureDigest: source.dependencyClosureDigest,
    dispose: () => source.dispose(),
    disposeAsync: () => source.disposeAsync(),
    publish: (binding: PluginSourceSnapshotBinding) =>
      withPluginLifecycleLeaseAsync(
        { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
        async (lease) => {
          const staged = await source.stage(binding);
          try {
            await updatePluginSnapshotCandidates({
              stateDir,
              lease,
              operation: "retain",
              candidates: [staged.descriptor],
            });
            await lease.assertOwned();
            return await staged.publish();
          } finally {
            await staged.disposeAsync();
          }
        },
      ),
  };
}
