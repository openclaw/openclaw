import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import type { DatabasePortPluginOwners } from "./port-descriptor.js";
import { requireDatabasePortProvider } from "./port-provider.js";

/** Offline operations retain the selected plugin's source/build family for owner callbacks. */
export async function loadDatabasePortDescriptor(
  id: string,
  config: OpenClawConfig = {},
  options: { version?: number; pluginOwners?: DatabasePortPluginOwners } = {},
) {
  const { pluginOwners, version } = options;
  const provider = requireDatabasePortProvider(id);
  const owner = provider.requiresPluginOwner
    ? pluginOwners
      ? pluginOwners[id]
      : withArtifactPreservingStateReads(() =>
          resolvePluginMetadataSnapshot({ config }).byPluginId.get(id),
        )
    : undefined;
  return provider.loadDescriptor(owner, version);
}
