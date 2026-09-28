/** Normalizes manifest-declared CLI command aliases. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

type PluginManifestCommandAliasKind = "runtime-slash";

/** One command alias declared by a plugin manifest. */
export type PluginManifestCommandAlias = {
  /** Command-like name users may put in plugin config by mistake. */
  name: string;
  /** Command family, used for targeted diagnostics. */
  kind?: PluginManifestCommandAliasKind;
  /** Optional root CLI command that handles related CLI operations. */
  cliCommand?: string;
};

export type PluginManifestCommandAliasRecord = PluginManifestCommandAlias & {
  pluginId: string;
  enabledByDefault?: boolean;
};

export type PluginManifestToolOwnerRecord = {
  toolName: string;
  pluginId: string;
  /**
   * "loaded" passes manifest policy and tool availability checks; "manifest-only"
   * supports only a "may be provided by" diagnostic. Neither proves live registration.
   */
  availability?: "loaded" | "manifest-only";
};

export type PluginManifestCommandAliasRegistry = {
  plugins: readonly {
    id: string;
    enabledByDefault?: boolean;
    commandAliases?: readonly PluginManifestCommandAlias[];
    contracts?: { tools?: readonly string[] };
  }[];
};

/** Normalizes manifest command alias records and reports duplicate/invalid entries. */
export function normalizeManifestCommandAliases(
  value: unknown,
): PluginManifestCommandAlias[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: PluginManifestCommandAlias[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const name = normalizeOptionalString(entry) ?? "";
      if (name) {
        normalized.push({ name });
      }
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const name = normalizeOptionalString(entry.name) ?? "";
    if (!name) {
      continue;
    }
    const kind = entry.kind === "runtime-slash" ? entry.kind : undefined;
    const cliCommand = normalizeOptionalString(entry.cliCommand) ?? "";
    normalized.push({
      name,
      ...(kind ? { kind } : {}),
      ...(cliCommand ? { cliCommand } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveManifestToolOwnerInRegistry(params: {
  toolName: string | undefined;
  registry: PluginManifestCommandAliasRegistry;
}): PluginManifestToolOwnerRecord | undefined {
  const normalizedToolName = normalizeOptionalLowercaseString(params.toolName);
  if (!normalizedToolName) {
    return undefined;
  }
  for (const plugin of params.registry.plugins) {
    const tools = plugin.contracts?.tools;
    if (!tools || tools.length === 0) {
      continue;
    }
    const match = tools.find(
      (entry) => normalizeOptionalLowercaseString(entry) === normalizedToolName,
    );
    if (match) {
      return { toolName: match, pluginId: plugin.id };
    }
  }
  return undefined;
}

export function resolveManifestCommandAliasOwnerInRegistry(params: {
  command: string | undefined;
  registry: PluginManifestCommandAliasRegistry;
}): PluginManifestCommandAliasRecord | undefined {
  const normalizedCommand = normalizeOptionalLowercaseString(params.command);
  if (!normalizedCommand) {
    return undefined;
  }

  const commandIsPluginId = params.registry.plugins.some(
    (plugin) => normalizeOptionalLowercaseString(plugin.id) === normalizedCommand,
  );

  for (const plugin of params.registry.plugins) {
    const alias = plugin.commandAliases?.find(
      (entry) => normalizeOptionalLowercaseString(entry.name) === normalizedCommand,
    );
    if (alias) {
      if (commandIsPluginId && normalizeOptionalLowercaseString(plugin.id) !== normalizedCommand) {
        continue;
      }
      return {
        ...alias,
        pluginId: plugin.id,
        ...(plugin.enabledByDefault === true ? { enabledByDefault: true } : {}),
      };
    }
  }
  return undefined;
}
