import { isSensitiveUrlConfigPath } from "../shared/net/redact-sensitive-url.js";
import { VERSION } from "../version.js";
import type { ConfigUiHints } from "./schema.hints.js";
import {
  applySensitiveUrlHints,
  buildBaseHints,
  collectMatchingSchemaPaths,
  mapSensitivePaths,
} from "./schema.hints.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
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

/**
 * Build a merged description lookup: FIELD_HELP (rich prose) takes priority,
 * falling back to FIELD_LABELS (short label) when no help text exists.
 */
function buildDescriptionMap(): Record<string, string> {
  const merged: Record<string, string> = { ...FIELD_LABELS };
  // FIELD_HELP overwrites FIELD_LABELS for every key it covers
  for (const [key, value] of Object.entries(FIELD_HELP)) {
    if (value) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Recursively walk a JSON Schema object and apply `description` from the
 * merged help/labels map using dot-path matching.  Existing descriptions
 * (e.g. from Zod `.describe()`) are never overwritten.
 */
function applyDescriptions(
  node: JsonSchemaObject,
  descriptions: Record<string, string>,
  prefix: string = "",
): void {
  const props = node.properties;
  if (props) {
    for (const [key, child] of Object.entries(props)) {
      const childObj = asJsonSchemaObject(child);
      if (!childObj) {
        continue;
      }
      const dotPath = prefix ? `${prefix}.${key}` : key;
      // Apply description only if none already present
      if (!childObj.description && descriptions[dotPath]) {
        childObj.description = descriptions[dotPath];
      }
      // Recurse into nested properties
      applyDescriptions(childObj, descriptions, dotPath);
    }
  }
  // Handle additionalProperties (wildcard keys like "models.providers.*")
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    const addObj = asJsonSchemaObject(node.additionalProperties);
    if (addObj) {
      const wildcardPath = prefix ? `${prefix}.*` : "*";
      if (!addObj.description && descriptions[wildcardPath]) {
        addObj.description = descriptions[wildcardPath];
      }
      applyDescriptions(addObj, descriptions, wildcardPath);
    }
  }
  // Handle array items. Labels may use either "[]" notation (bindings[].type)
  // or wildcard "*" notation (agents.list.*.skills), so try both aliases.
  if (node.items) {
    const itemsObj = asJsonSchemaObject(node.items);
    if (itemsObj) {
      const arrayPath = prefix ? `${prefix}[]` : "[]";
      const wildcardAlias = prefix ? `${prefix}.*` : "*";
      if (!itemsObj.description) {
        const desc = descriptions[arrayPath] ?? descriptions[wildcardAlias];
        if (desc) {
          itemsObj.description = desc;
        }
      }
      // Recurse with the [] path, but also merge descriptions reachable
      // via the * alias so that nested children match either convention.
      applyDescriptions(itemsObj, descriptions, arrayPath);
      if (wildcardAlias !== arrayPath) {
        applyDescriptions(itemsObj, descriptions, wildcardAlias);
      }
    }
  }
  // Recurse into composition branches (anyOf, oneOf, allOf) using the
  // same prefix so that properties nested inside union/intersection
  // variants can still be annotated.
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const branchObj = asJsonSchemaObject(branch);
        if (branchObj) {
          applyDescriptions(branchObj, descriptions, prefix);
        }
      }
    }
  }
}

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
  const schemaRoot = asJsonSchemaObject(schema);
  if (schemaRoot) {
    applyDescriptions(schemaRoot, buildDescriptionMap());
  }
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
