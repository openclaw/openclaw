import { buildPluginToolMetadataKey } from "./tools.js";

export type ReadablePluginToolMetadata = {
  toolName: string;
  displayName?: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};

function readObjectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    const field = (value as Record<string, unknown>)[key];
    return field && typeof field === "object" && !Array.isArray(field)
      ? (field as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  } catch {
    return undefined;
  }
}

function readRiskField(value: unknown): "low" | "medium" | "high" | undefined {
  const risk = readStringField(value, "risk");
  return risk === "low" || risk === "medium" || risk === "high" ? risk : undefined;
}

function readTagsField(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  try {
    const tags = (value as Record<string, unknown>).tags;
    return Array.isArray(tags) && tags.every((tag) => typeof tag === "string")
      ? [...tags]
      : undefined;
  } catch {
    return undefined;
  }
}

function readEntry(entries: readonly unknown[], index: number): unknown {
  try {
    return entries[index];
  } catch {
    return undefined;
  }
}

/** Builds stable plugin tool metadata rows without trusting plugin-owned accessors. */
export function buildReadablePluginToolMetadataMap(
  entries: unknown,
): ReadonlyMap<string, ReadablePluginToolMetadata> {
  const metadataByKey = new Map<string, ReadablePluginToolMetadata>();
  if (!Array.isArray(entries)) {
    return metadataByKey;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = readEntry(entries, index);
    const pluginId = readStringField(entry, "pluginId");
    const metadata = readObjectField(entry, "metadata");
    const toolName = readStringField(metadata, "toolName");
    if (!pluginId || !toolName) {
      continue;
    }
    const displayName = readStringField(metadata, "displayName");
    const description = readStringField(metadata, "description");
    const risk = readRiskField(metadata);
    const tags = readTagsField(metadata);
    metadataByKey.set(buildPluginToolMetadataKey(pluginId, toolName), {
      toolName,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(risk !== undefined ? { risk } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
  }
  return metadataByKey;
}
