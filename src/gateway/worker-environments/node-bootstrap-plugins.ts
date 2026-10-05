import type { WorkerExecutionMode } from "../../plugins/capability-provider.types.js";
import { isBundledManifestOwner } from "../../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";

/** Data projection of a validated generation, with no executable plugin callbacks. */
export type NodeBootstrapPluginSelection = {
  registry: {
    plugins: readonly Pick<
      PluginRegistry["plugins"][number],
      "id" | "enabled" | "status" | "rootDir" | "packageName" | "packageVersion"
    >[];
    agentHarnesses: readonly {
      pluginId: string;
      harness: Pick<PluginRegistry["agentHarnesses"][number]["harness"], "cloudPlacement">;
    }[];
    nodeHostCommands: readonly {
      pluginId: string;
      command: Pick<PluginRegistry["nodeHostCommands"][number]["command"], "command">;
    }[];
  };
  metadata: {
    byPluginId: ReadonlyMap<
      string,
      Pick<
        PluginManifestRecord,
        "origin" | "trustedOfficialInstall" | "rootDir" | "packageName" | "packageVersion"
      >
    >;
  };
  executionMode?: WorkerExecutionMode;
};

/** Selects node runtime packages from the Gateway's already validated plugin generation. */
export function resolveNodeBootstrapPlugins(
  params: NodeBootstrapPluginSelection,
): Array<{ id: string; root: string }> {
  if (params.executionMode !== "remote-exec") {
    return [];
  }
  const availablePlugins = new Map(
    params.registry.plugins
      .filter((plugin) => plugin.enabled && plugin.status === "loaded")
      .map((plugin) => [plugin.id, plugin]),
  );
  // Environments persist execution mode, not harness identity. Install the union
  // of that mode's requirements; placement and node policy still authorize use.
  const requiredCommands = new Set(
    params.registry.agentHarnesses.flatMap(({ pluginId, harness }) =>
      availablePlugins.has(pluginId) && harness.cloudPlacement?.mode === params.executionMode
        ? (harness.cloudPlacement?.devicePlacement?.requiredNodeCommands ?? [])
        : [],
    ),
  );
  const pluginIds = new Set<string>();
  for (const command of requiredCommands) {
    const owner = params.registry.nodeHostCommands.find(
      (entry) => entry.command.command === command,
    );
    if (!owner || !availablePlugins.has(owner.pluginId)) {
      throw new Error(
        `Cloud node bootstrap requires an available plugin for node command ${command}`,
      );
    }
    pluginIds.add(owner.pluginId);
  }
  return [...pluginIds].toSorted().map((id) => {
    const plugin = params.metadata.byPluginId.get(id);
    const loaded = availablePlugins.get(id);
    if (
      !plugin ||
      !loaded ||
      (!isBundledManifestOwner(plugin) && plugin.trustedOfficialInstall !== true) ||
      !plugin.rootDir ||
      !plugin.packageName ||
      !plugin.packageVersion ||
      plugin.rootDir !== loaded.rootDir ||
      plugin.packageName !== loaded.packageName ||
      plugin.packageVersion !== loaded.packageVersion
    ) {
      throw new Error(
        `Cloud node bootstrap requires the loaded trusted package for plugin ${id}; repair its installation and restart the Gateway`,
      );
    }
    return { id, root: plugin.rootDir };
  });
}
