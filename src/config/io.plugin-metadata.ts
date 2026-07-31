import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshotPluginIdScope } from "../plugins/plugin-metadata-snapshot.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Merges validation metadata from every configured agent workspace. */
function mergeValidationPluginMetadataSnapshots(
  snapshots: readonly PluginMetadataSnapshot[],
): PluginMetadataSnapshot {
  const first = snapshots[0];
  if (!first) {
    throw new Error("Cannot merge an empty plugin metadata snapshot set.");
  }
  if (snapshots.length === 1) {
    return first;
  }
  const recordsByPluginId = new Map<
    string,
    Map<string, PluginMetadataSnapshot["plugins"][number]>
  >();
  for (const metadata of snapshots) {
    for (const plugin of metadata.manifestRegistry.plugins) {
      const pluginId = first.normalizePluginId(plugin.id);
      const bySource = recordsByPluginId.get(pluginId) ?? new Map();
      bySource.set(plugin.source, plugin);
      recordsByPluginId.set(pluginId, bySource);
    }
  }
  const diagnostics = snapshots.flatMap((metadata) => metadata.manifestRegistry.diagnostics);
  const plugins: PluginMetadataSnapshot["manifestRegistry"]["plugins"] = [];
  for (const [pluginId, bySource] of recordsByPluginId) {
    if (bySource.size > 1) {
      diagnostics.push({
        level: "error",
        pluginId,
        message: `plugin id ${JSON.stringify(pluginId)} is present in multiple agent workspaces: ${[...bySource.keys()].toSorted().join(", ")}`,
      });
      continue;
    }
    const plugin = bySource.values().next().value;
    if (plugin) {
      plugins.push(plugin);
    }
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id));
  return {
    ...first,
    workspaceDir: undefined,
    pluginIds: undefined,
    plugins,
    diagnostics,
    manifestRegistry: { plugins, diagnostics },
    byPluginId: new Map(plugins.map((plugin) => [first.normalizePluginId(plugin.id), plugin])),
  };
}

/** Resolves one conflict-checked metadata snapshot across all agent workspaces. */
export function resolveConfigWidePluginMetadataSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
}): PluginMetadataSnapshot {
  const env = params.env ?? process.env;
  const workspaceDirs = listAgentWorkspaceDirs(params.config, env);
  const scopes: Array<string | undefined> = workspaceDirs.length > 0 ? workspaceDirs : [undefined];
  return mergeValidationPluginMetadataSnapshots(
    scopes.map((workspaceDir) =>
      resolvePluginMetadataSnapshot({
        config: params.config,
        ...(workspaceDir ? { workspaceDir } : {}),
        env,
        allowWorkspaceScopedCurrent: true,
        ...(params.pluginIdScope ? { pluginIdScope: params.pluginIdScope } : {}),
      }),
    ),
  );
}
