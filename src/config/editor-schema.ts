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
