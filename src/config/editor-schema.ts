import fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic } from "../infra/replace-file.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

export const EDITOR_CONFIG_SCHEMA_FILENAME = "openclaw.schema.json";
export const EDITOR_CONFIG_SCHEMA_REF = `./${EDITOR_CONFIG_SCHEMA_FILENAME}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findJson5RootObjectStart(raw: string): number | null {
  let index = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (char === "/" && raw[index + 1] === "/") {
      const newlineIndex = raw.indexOf("\n", index + 2);
      if (newlineIndex < 0) {
        return null;
      }
      index = newlineIndex + 1;
      continue;
    }
    if (char === "/" && raw[index + 1] === "*") {
      const commentEnd = raw.indexOf("*/", index + 2);
      if (commentEnd < 0) {
        return null;
      }
      index = commentEnd + 2;
      continue;
    }
    return char === "{" ? index : null;
  }
  return null;
}

export function insertEditorConfigSchemaRefRaw(params: {
  raw: string | null;
  parsed: unknown;
  schemaRef?: string;
}): string | null {
  if (params.raw === null || !isRecord(params.parsed)) {
    return null;
  }
  const currentSchema = params.parsed.$schema;
  const schemaRef = params.schemaRef ?? EDITOR_CONFIG_SCHEMA_REF;
  if (typeof currentSchema === "string") {
    if (currentSchema.trim()) {
      return null;
    }
    const blankSchemaPattern = /((?:"\$schema"|'\$schema'|\$schema)\s*:\s*)(["'])[\t ]*\2/u;
    const objectStart = findJson5RootObjectStart(params.raw);
    if (objectStart === null) {
      return null;
    }
    const rawPrefix = params.raw.slice(0, objectStart);
    const rawRoot = params.raw.slice(objectStart);
    const replacedRoot = rawRoot.replace(blankSchemaPattern, `$1${JSON.stringify(schemaRef)}`);
    const replacedRaw = replacedRoot === rawRoot ? params.raw : `${rawPrefix}${replacedRoot}`;
    return replacedRaw === params.raw ? null : replacedRaw;
  }
  if (currentSchema !== undefined) {
    return null;
  }
  const objectStart = findJson5RootObjectStart(params.raw);
  if (objectStart === null) {
    return null;
  }
  const newline = params.raw.includes("\r\n") ? "\r\n" : "\n";
  let restStart = objectStart + 1;
  if (params.raw.startsWith("\r\n", restStart)) {
    restStart += 2;
  } else if (params.raw.startsWith("\n", restStart)) {
    restStart += 1;
  }
  return [
    params.raw.slice(0, objectStart + 1),
    `${newline}  "$schema": ${JSON.stringify(schemaRef)},${newline}`,
    params.raw.slice(restStart),
  ].join("");
}

export function buildEditorConfigSchema(
  response: Pick<ConfigSchemaResponse, "schema">,
): Record<string, unknown> {
  const schema = structuredClone(response.schema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  schema.properties = {
    $schema: { type: "string" },
    ...schema.properties,
  };

  return schema;
}

export function buildEditorConfigSchemaFromPluginMetadata(
  pluginMetadataSnapshot?: PluginMetadataSnapshot,
): Record<string, unknown> {
  const manifestRegistry = pluginMetadataSnapshot?.manifestRegistry;
  return buildEditorConfigSchema(
    buildConfigSchema({
      plugins: manifestRegistry ? collectPluginSchemaMetadata(manifestRegistry) : [],
      channels: manifestRegistry ? collectChannelSchemaMetadata(manifestRegistry) : [],
    }),
  );
}

export async function writeEditorConfigSchemaFile(params: {
  configPath: string;
  fsModule?: typeof fs;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): Promise<void> {
  const schemaPath = path.join(path.dirname(params.configPath), EDITOR_CONFIG_SCHEMA_FILENAME);
  const schema = buildEditorConfigSchemaFromPluginMetadata(params.pluginMetadataSnapshot);
  await replaceFileAtomic({
    filePath: schemaPath,
    content: `${JSON.stringify(schema, null, 2)}\n`,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(schemaPath),
    copyFallbackOnPermissionError: true,
    ...(params.fsModule ? { fileSystem: params.fsModule } : {}),
  });
}
