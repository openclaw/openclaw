import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";

/** Direct tool fixtures borrow the metadata scope normally prepared by their runtime host. */
export async function withToolTestMetadata<T>(
  config: OpenClawConfig,
  run: () => T,
): Promise<Awaited<T>> {
  const env = { ...process.env };
  await using cache = createPluginCache();
  return await withPluginCache(cache, async () => {
    const snapshot = await resolvePluginMetadataSnapshotAsync({ config, env });
    return await withPluginMetadataSnapshotScope(snapshot, run, { config, env });
  });
}
