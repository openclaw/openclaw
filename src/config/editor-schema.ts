import type { ConfigSchemaResponse } from "./schema.js";
import type { OpenClawConfig } from "./types.js";

export const PUBLIC_CONFIG_SCHEMA_URL = "https://docs.openclaw.ai/schema/openclaw.json";

type JsonSchemaRoot = Record<string, unknown> & {
  properties?: Record<string, unknown>;
};

function hasNonEmptySchemaRef(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildEditorConfigSchemaDocument(
  response: Pick<ConfigSchemaResponse, "schema">,
): Record<string, unknown> {
  const schema = structuredClone(response.schema) as JsonSchemaRoot;
  schema.properties = {
    $schema: { type: "string" },
    ...schema.properties,
  };
  return schema;
}

export function withDefaultPublicConfigSchemaRef(config: OpenClawConfig): OpenClawConfig {
  if (hasNonEmptySchemaRef(config.$schema)) {
    return config;
  }
  const { $schema: _unused, ...rest } = config;
  return {
    $schema: PUBLIC_CONFIG_SCHEMA_URL,
    ...rest,
  };
}
