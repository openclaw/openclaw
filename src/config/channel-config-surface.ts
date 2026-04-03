import fs from "node:fs";
import path from "node:path";
import { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type { ChannelConfigSchema } from "../channels/plugins/types.plugin.js";

export type BuiltChannelConfigSurface = ChannelConfigSchema;

export function isBuiltChannelConfigSchema(value: unknown): value is BuiltChannelConfigSurface {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

export function resolveChannelConfigSurfaceExport(
  imported: Record<string, unknown>,
): BuiltChannelConfigSurface | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return buildChannelConfigSchema(value as never);
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

export function resolveChannelConfigSchemaModulePath(rootDir: string): string | null {
  const candidates = [
    path.join(rootDir, "src", "config-schema.ts"),
    path.join(rootDir, "src", "config-schema.js"),
    path.join(rootDir, "src", "config-schema.mts"),
    path.join(rootDir, "src", "config-schema.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
