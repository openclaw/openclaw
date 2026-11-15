import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import type {
  DatabasePortPluginOwners,
  DatabasePortDescriptorIdentity,
} from "./port-descriptor.js";
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

/** Compatibility reads host-pinned schema facts, not an optional plugin's runtime availability. */
export async function loadDatabasePortDescriptorIdentity(
  id: string,
  config: OpenClawConfig,
  options: { pluginOwners: DatabasePortPluginOwners },
): Promise<DatabasePortDescriptorIdentity> {
  const provider = requireDatabasePortProvider(id);
  const descriptor = provider.loadIdentity
    ? await provider.loadIdentity()
    : await loadDatabasePortDescriptor(id, config, options);
  return {
    id: descriptor.id,
    version: descriptor.version,
    tables: descriptor.tables,
    expectedCatalog: descriptor.expectedCatalog,
    fragments: descriptor.fragments,
  };
}
