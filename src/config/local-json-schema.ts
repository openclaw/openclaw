import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "./types.js";

export const LOCAL_CONFIG_SCHEMA_FILENAME = "openclaw_schema.json";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptySchemaRef(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isConfigJsonSchemaMaintenanceEnabled(
  config: Pick<OpenClawConfig, "update">,
): boolean {
  return config.update?.maintainConfigJsonSchema ?? true;
}

export function withDefaultLocalConfigSchemaRef(config: OpenClawConfig): OpenClawConfig {
  if (!isConfigJsonSchemaMaintenanceEnabled(config) || hasNonEmptySchemaRef(config.$schema)) {
    return config;
  }
  return {
    ...config,
    $schema: LOCAL_CONFIG_SCHEMA_FILENAME,
  };
}

export function resolveLocalConfigSchemaPath(configPath: string): string {
  return path.join(path.dirname(configPath), LOCAL_CONFIG_SCHEMA_FILENAME);
}

export async function buildEditorConfigSchemaDocument(): Promise<JsonObject> {
  const { readBestEffortRuntimeConfigSchema } = await import("./runtime-schema.js");
  const response = await readBestEffortRuntimeConfigSchema();
  const schema = structuredClone(response.schema) as JsonObject & {
    properties?: JsonObject;
    meta?: JsonObject;
  };
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const meta = isPlainObject(schema.meta) ? schema.meta : {};
  schema.properties = {
    $schema: { type: "string" },
    ...properties,
  };
  schema.meta = {
    ...meta,
    version: response.version,
  };
  return schema;
}

export async function writeLocalConfigJsonSchemaFile(params: {
  configPath: string;
  config: Pick<OpenClawConfig, "update">;
  fsModule?: Pick<typeof fs, "promises">;
}): Promise<boolean> {
  if (!isConfigJsonSchemaMaintenanceEnabled(params.config)) {
    return false;
  }

  const fsModule = params.fsModule ?? fs;
  const schemaPath = resolveLocalConfigSchemaPath(params.configPath);
  const nextDocument = await buildEditorConfigSchemaDocument();
  const nextRaw = JSON.stringify(nextDocument, null, 2).trimEnd().concat("\n");

  let currentRaw: string | null = null;
  try {
    currentRaw = await fsModule.promises.readFile(schemaPath, "utf-8");
  } catch {
    currentRaw = null;
  }

  if (currentRaw === nextRaw) {
    return false;
  }

  await fsModule.promises.mkdir(path.dirname(schemaPath), { recursive: true, mode: 0o700 });
  await fsModule.promises.writeFile(schemaPath, nextRaw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return true;
}

export async function maintainLocalConfigJsonSchemaArtifacts(): Promise<void> {
  const { readConfigFileSnapshotForWrite, writeConfigFile } = await import("./config.js");
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (snapshot.exists && !snapshot.valid) {
    return;
  }
  const nextConfig = withDefaultLocalConfigSchemaRef(snapshot.config);
  if (snapshot.exists && nextConfig !== snapshot.config) {
    await writeConfigFile(nextConfig, writeOptions);
    return;
  }
  await writeLocalConfigJsonSchemaFile({
    configPath: snapshot.path,
    config: nextConfig,
  });
}
