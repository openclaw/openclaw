import path from "node:path";
import { resolveActivatedPluginBackupInventory } from "../plugins/manifest-backup-resources.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type {
  BackupDatabaseDiscoveryInput,
  BackupDatabaseDiscoveryReply,
} from "./backup-database-discovery.types.js";
import { discoverBackupDatabasePaths } from "./backup-sqlite-snapshot.js";
import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { listDatabaseEngineStores } from "./database-engine/registry.js";
import { statePortProvider } from "./database-engine/state-port.js";
import { serveWorkerTasks } from "./worker-task-server.js";

serveWorkerTasks<BackupDatabaseDiscoveryReply, BackupDatabaseDiscoveryInput>(async (input) => {
  const selected = await resolveDatabaseEngineSelection(input.config, {
    ...process.env,
    ...input.env,
  });
  return withDatabaseEngineSelection(selected, async () => {
    const paths = await discoverBackupDatabasePaths(input);
    const plugins = resolvePluginMetadataSnapshot(input);
    const families = new Set<string>(
      listDatabaseEngineStores()
        .filter((store) => store.postgres)
        .map((store) => store.id),
    );
    const pluginOwners = Object.fromEntries(
      plugins.plugins.map(({ id, rootDir, source, origin }) => [
        id,
        { id, rootDir, source, origin },
      ]),
    );
    return {
      paths,
      resources: plugins.plugins.flatMap((plugin) =>
        (plugin.backupResources ?? []).flatMap((resource) => {
          const family = resource.databaseFamily ?? plugin.id;
          return resource.scope === "state" &&
            resource.disposition === "include" &&
            families.has(family)
            ? [
                {
                  path: path.resolve(input.stateDir, resource.relativePath),
                  family,
                  pluginId: plugin.id,
                },
              ]
            : [];
        }),
      ),
      stateRoots: await statePortProvider.resolveRoots({
        ...input,
        env: input.env ?? process.env,
        plugins,
      }),
      pluginOwners,
      pluginInventory: resolveActivatedPluginBackupInventory(input),
    };
  });
});
