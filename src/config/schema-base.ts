import { VERSION } from "../version.js";
import type { ConfigUiHints } from "./schema.hints.js";
import { buildBaseHints, mapSensitivePaths } from "./schema.hints.js";
import { asSchemaObject, cloneSchema } from "./schema.shared.js";
import { applyDerivedTags } from "./schema.tags.js";
import { OpenClawSchema } from "./zod-schema.js";

type ConfigSchema = Record<string, unknown>;

type JsonSchemaObject = Record<string, unknown> & {
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
};

const asJsonSchemaObject = (value: unknown): JsonSchemaObject | null =>
  asSchemaObject<JsonSchemaObject>(value);

export type BaseConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

type BaseConfigSchemaStablePayload = Omit<BaseConfigSchemaResponse, "generatedAt">;

function stripChannelSchema(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asJsonSchemaObject(next);
  if (!root || !root.properties) {
    return next;
  }
  // Allow `$schema` in config files for editor tooling, but hide it from the
  // Control UI form schema so it does not show up as a configurable section.
  delete root.properties.$schema;
  if (Array.isArray(root.required)) {
    root.required = root.required.filter((key) => key !== "$schema");
  }
  const channelsNode = asJsonSchemaObject(root.properties.channels);
  if (channelsNode) {
    channelsNode.properties = {};
    channelsNode.required = [];
    channelsNode.additionalProperties = true;
  }
  return next;
}

let baseConfigSchemaStablePayload: BaseConfigSchemaStablePayload | null = null;

function computeBaseConfigSchemaStablePayload(): BaseConfigSchemaStablePayload {
  if (baseConfigSchemaStablePayload) {
    return {
      schema: cloneSchema(baseConfigSchemaStablePayload.schema),
      uiHints: cloneSchema(baseConfigSchemaStablePayload.uiHints),
      version: baseConfigSchemaStablePayload.version,
    };
  }
  const schema = OpenClawSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "OpenClawConfig";
  const stablePayload = {
    schema: stripChannelSchema(schema),
    uiHints: applyDerivedTags(mapSensitivePaths(OpenClawSchema, "", buildBaseHints())),
    version: VERSION,
  } satisfies BaseConfigSchemaStablePayload;
  baseConfigSchemaStablePayload = stablePayload;
  return {
    schema: cloneSchema(stablePayload.schema),
    uiHints: cloneSchema(stablePayload.uiHints),
    version: stablePayload.version,
  };
}

export function computeBaseConfigSchemaResponse(params?: {
  generatedAt?: string;
}): BaseConfigSchemaResponse {
  const stablePayload = computeBaseConfigSchemaStablePayload();
  return {
    schema: stablePayload.schema,
    uiHints: stablePayload.uiHints,
    version: stablePayload.version,
    generatedAt: params?.generatedAt ?? new Date().toISOString(),
  };
}
