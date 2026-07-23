import type { CliCatalogVisibility } from "../cli/catalog-metadata.js";
import type { PluginCliDescriptorEntry } from "../plugins/cli-registry-loader.js";
import type { OpenClawPluginCliCommandDescriptor } from "../plugins/types.js";

export type CliCatalogPluginCommand = {
  readonly pluginId: string;
  readonly commandPath: readonly string[];
  readonly parentPath: readonly string[];
  readonly depth: number;
  readonly name: string;
  readonly descriptorName: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly hidden: false;
  readonly risk?: string;
  readonly confirmationRequired?: boolean;
  readonly effectMode?: string;
  readonly commandHints: readonly string[];
  readonly sourceKind: "plugin";
  readonly sourceId: string;
  readonly discoveryMode: "plugin-descriptor";
  readonly visibility: readonly CliCatalogVisibility[];
};

function isHiddenDescriptor(descriptor: OpenClawPluginCliCommandDescriptor): boolean {
  return (descriptor as OpenClawPluginCliCommandDescriptor & { hidden?: boolean }).hidden === true;
}

function defaultVisibility(
  descriptor?: OpenClawPluginCliCommandDescriptor,
): readonly CliCatalogVisibility[] {
  return descriptor?.commandExposure?.tier === "internal"
    ? (["audit", "operator", "policy"] as const)
    : (["docs", "audit", "operator", "policy"] as const);
}

export function buildPluginCatalogCommands(
  entries: readonly PluginCliDescriptorEntry[],
): readonly CliCatalogPluginCommand[] {
  return entries.flatMap((entry) => {
    const descriptorNames = new Set(entry.descriptors.map((descriptor) => descriptor.name));
    const descriptorCommands = entry.descriptors
      .filter((descriptor) => !isHiddenDescriptor(descriptor))
      .map((descriptor) => {
        const commandPath = [...entry.parentPath, descriptor.name];
        return {
          pluginId: entry.pluginId,
          commandPath,
          parentPath: entry.parentPath,
          depth: commandPath.length,
          name: descriptor.name,
          descriptorName: descriptor.name,
          description: descriptor.description,
          hasSubcommands: descriptor.hasSubcommands,
          hidden: false as const,
          ...(descriptor.effectProfile?.risk ? { risk: descriptor.effectProfile.risk } : {}),
          ...(descriptor.effectProfile?.confirmationRequired !== undefined
            ? { confirmationRequired: descriptor.effectProfile.confirmationRequired }
            : {}),
          ...(descriptor.effectProfile?.effectMode
            ? { effectMode: descriptor.effectProfile.effectMode }
            : {}),
          commandHints: [commandPath.join(" ")],
          sourceKind: "plugin" as const,
          sourceId: `${entry.pluginId}:${commandPath.join(" ")}`,
          discoveryMode: "plugin-descriptor" as const,
          visibility: defaultVisibility(descriptor),
        };
      });
    const commandOnly = (entry.commands ?? [])
      .filter((command) => !descriptorNames.has(command))
      .map((command) => {
        const commandPath = [...entry.parentPath, command];
        return {
          pluginId: entry.pluginId,
          commandPath,
          parentPath: entry.parentPath,
          depth: commandPath.length,
          name: command,
          descriptorName: command,
          description: "Plugin CLI command registered without descriptor metadata",
          hasSubcommands: false,
          hidden: false as const,
          commandHints: [commandPath.join(" ")],
          sourceKind: "plugin" as const,
          sourceId: `${entry.pluginId}:${commandPath.join(" ")}`,
          discoveryMode: "plugin-descriptor" as const,
          visibility: ["audit", "operator", "policy"] as const,
        };
      });
    return [...descriptorCommands, ...commandOnly];
  });
}
