import { isSensitiveUrlConfigPath } from "../shared/net/redact-sensitive-url.js";
import { VERSION } from "../version.js";
import type { ConfigUiHints } from "./schema.hints.js";
import {
  applySensitiveUrlHints,
  buildBaseHints,
  collectMatchingSchemaPaths,
  mapSensitivePaths,
} from "./schema.hints.js";
import { asSchemaObject, cloneSchema } from "./schema.shared.js";
import { applyDerivedTags } from "./schema.tags.js";
import { OpenClawSchema } from "./zod-schema.js";

type ConfigSchema = Record<string, unknown>;

type JsonSchemaObject = Record<string, unknown> & {
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
};

const LEGACY_HIDDEN_PUBLIC_PATHS = ["hooks.internal.handlers"] as const;

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

function stripObjectPropertyPath(schema: ConfigSchema, path: readonly string[]): void {
  const root = asJsonSchemaObject(schema);
  if (!root || path.length === 0) {
    return;
  }

  let current: JsonSchemaObject | null = root;
  for (const segment of path.slice(0, -1)) {
    current = asJsonSchemaObject(current?.properties?.[segment]);
    if (!current) {
      return;
    }
  }

  const key = path[path.length - 1];
  if (!current?.properties || !key) {
    return;
  }
  delete current.properties[key];
  if (Array.isArray(current.required)) {
    current.required = current.required.filter((entry) => entry !== key);
  }
}

function stripLegacyCompatSchemaPaths(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  for (const path of LEGACY_HIDDEN_PUBLIC_PATHS) {
    stripObjectPropertyPath(next, path.split("."));
  }
  return next;
}

function stripLegacyCompatHints(hints: ConfigUiHints): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const path of LEGACY_HIDDEN_PUBLIC_PATHS) {
    for (const key of Object.keys(next)) {
      if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) {
        delete next[key];
      }
    }
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
  const baseHints = mapSensitivePaths(OpenClawSchema, "", buildBaseHints());
  const sensitiveUrlPaths = collectMatchingSchemaPaths(
    OpenClawSchema,
    "",
    isSensitiveUrlConfigPath,
  );
  const stablePayload = {
    schema: stripLegacyCompatSchemaPaths(stripChannelSchema(schema)),
    uiHints: stripLegacyCompatHints(
      applyDerivedTags(applySensitiveUrlHints(baseHints, sensitiveUrlPaths)),
    ),
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
