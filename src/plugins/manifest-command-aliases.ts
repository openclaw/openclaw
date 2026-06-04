import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../utils.js";

export type PluginManifestCommandAliasKind = "runtime-slash";

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
   * "loaded" — the owning plugin passes control-plane availability filters and
   * the tool itself passes manifest-tool-availability checks (configSignals/
   * authSignals). The diagnostic can say the tool is available from this plugin.
   *
   * "manifest-only" — the manifest claims ownership but availability checks
   * either failed (plugin denied/disabled, missing required config) or were
   * not performed (pure registry lookup with no plugin metadata snapshot).
   * Emit a softer "may be provided by" message in that case so the diagnostic
   * does not over-assert about plugins that the runtime never registered.
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

function readRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function readArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      // Ignore only the unreadable row; readable siblings can still resolve.
    }
  }
  return entries;
}

function readManifestPluginId(plugin: unknown): string | undefined {
  return normalizeOptionalString(readRecordValue(plugin, "id"));
}

function readManifestCommandAlias(alias: unknown): PluginManifestCommandAlias | undefined {
  const name = normalizeOptionalString(readRecordValue(alias, "name"));
  if (!name) {
    return undefined;
  }
  const kind = readRecordValue(alias, "kind") === "runtime-slash" ? "runtime-slash" : undefined;
  const cliCommand = normalizeOptionalString(readRecordValue(alias, "cliCommand"));
  return {
    name,
    ...(kind ? { kind } : {}),
    ...(cliCommand ? { cliCommand } : {}),
  };
}

function readManifestCommandAliases(plugin: unknown): PluginManifestCommandAlias[] {
  return readArrayEntries(readRecordValue(plugin, "commandAliases"))
    .map(readManifestCommandAlias)
    .filter((alias): alias is PluginManifestCommandAlias => Boolean(alias));
}

function readManifestToolNames(plugin: unknown): string[] {
  const contracts = readRecordValue(plugin, "contracts");
  return readArrayEntries(readRecordValue(contracts, "tools"))
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

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
    const tools = readManifestToolNames(plugin);
    if (tools.length === 0) {
      continue;
    }
    const pluginId = readManifestPluginId(plugin);
    if (!pluginId) {
      continue;
    }
    for (const tool of tools) {
      if (normalizeOptionalLowercaseString(tool) === normalizedToolName) {
        return { toolName: tool, pluginId };
      }
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

  const commandIsPluginId = params.registry.plugins.some((plugin) => {
    const pluginId = readManifestPluginId(plugin);
    return pluginId ? normalizeOptionalLowercaseString(pluginId) === normalizedCommand : false;
  });

  for (const plugin of params.registry.plugins) {
    const pluginId = readManifestPluginId(plugin);
    if (!pluginId) {
      continue;
    }
    const alias = readManifestCommandAliases(plugin).find(
      (entry) => normalizeOptionalLowercaseString(entry.name) === normalizedCommand,
    );
    if (alias) {
      if (commandIsPluginId && normalizeOptionalLowercaseString(pluginId) !== normalizedCommand) {
        continue;
      }
      return {
        ...alias,
        pluginId,
        ...(readRecordValue(plugin, "enabledByDefault") === true ? { enabledByDefault: true } : {}),
      };
    }
  }
  return undefined;
}
