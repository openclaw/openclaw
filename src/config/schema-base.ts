import { VERSION } from "../version.js";
import { FIELD_HELP } from "./schema.help.js";
import { buildBaseHints, mapSensitivePaths } from "./schema.hints.js";
import { FIELD_LABELS } from "./schema.labels.js";
import {
  asSchemaObject,
  type ConfigJsonSchemaObject as JsonSchemaObject,
  type ConfigSchemaResponse,
} from "./schema.shared.js";
import { applyResolvedConfigTierHints } from "./schema.tiers.js";
import { OpenClawSchema } from "./zod-schema.js";

type ConfigSchema = Record<string, unknown>;

/**
 * Recursively walk a JSON Schema object and apply field docs using dot-path
 * matching. Existing titles/descriptions (for example from Zod metadata) are
 * preserved.
 */
function applyFieldDocumentation(node: JsonSchemaObject, prefixes: readonly string[] = [""]): void {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    applyChildDocumentation(
      child,
      prefixes.map((prefix) => (prefix ? `${prefix}.${key}` : key)),
    );
  }
  if (node.additionalProperties) {
    applyChildDocumentation(
      node.additionalProperties,
      prefixes.map((prefix) => (prefix ? `${prefix}.*` : "*")),
    );
  }
  // Array help/labels accept both bindings[].type and bindings.*.type.
  if (node.items) {
    applyChildDocumentation(node.items, [
      ...new Set(
        prefixes.flatMap((prefix) => (prefix ? [`${prefix}.*`, `${prefix}[]`] : ["*", "[]"])),
      ),
    ]);
  }
  // Recurse into composition branches (anyOf, oneOf, allOf) using the same
  // path aliases so union/intersection variants inherit the same field docs.
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const branchObj = asSchemaObject(branch);
        if (branchObj) {
          applyFieldDocumentation(branchObj, prefixes);
        }
      }
    }
  }
}

function applyChildDocumentation(value: unknown, pathCandidates: readonly string[]): void {
  const node = asSchemaObject(value);
  if (!node) {
    return;
  }
  for (const path of pathCandidates) {
    const title = FIELD_LABELS[path];
    if (!node.title && title) {
      node.title = title;
    }
    const description = FIELD_HELP[path];
    if (!node.description && description) {
      node.description = description;
    }
  }
  applyFieldDocumentation(node, pathCandidates);
}

type BaseConfigSchemaStablePayload = Omit<ConfigSchemaResponse, "generatedAt">;

function preparePublicSchema(schema: ConfigSchema): ConfigSchema {
  // Zod returns an independent JSON tree; prepare it before publishing the cache.
  const root = asSchemaObject(schema);
  if (!root || !root.properties) {
    return schema;
  }
  // Allow `$schema` in config files for editor tooling, but hide it from the
  // Control UI form schema so it does not show up as a configurable section.
  delete root.properties.$schema;
  if (Array.isArray(root.required)) {
    root.required = root.required.filter((key) => key !== "$schema");
  }
  const channelsNode = asSchemaObject(root.properties.channels);
  if (channelsNode) {
    // Keep plugin config permissive without advertising an untyped lookup wildcard.
    channelsNode.additionalProperties = true;
  }
  return schema;
}

let baseConfigSchemaStablePayload: BaseConfigSchemaStablePayload | null = null;

function computeBaseConfigSchemaStablePayload(): BaseConfigSchemaStablePayload {
  if (baseConfigSchemaStablePayload) {
    return baseConfigSchemaStablePayload;
  }
  const schema = OpenClawSchema.toJSONSchema({
    io: "input",
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "OpenClawConfig";
  const schemaRoot = asSchemaObject(schema);
  if (schemaRoot) {
    applyFieldDocumentation(schemaRoot);
  }
  const baseHints = mapSensitivePaths(OpenClawSchema, "", buildBaseHints());
  const publicSchema = preparePublicSchema(schema);
  const stablePayload = {
    schema: publicSchema,
    uiHints: applyResolvedConfigTierHints(publicSchema, baseHints),
    version: VERSION,
  } satisfies BaseConfigSchemaStablePayload;
  baseConfigSchemaStablePayload = stablePayload;
  return stablePayload;
}

export function computeBaseConfigSchemaResponse(params?: {
  generatedAt?: string;
}): ConfigSchemaResponse {
  const stablePayload = computeBaseConfigSchemaStablePayload();
  return {
    schema: structuredClone(stablePayload.schema),
    uiHints: structuredClone(stablePayload.uiHints),
    version: stablePayload.version,
    generatedAt: params?.generatedAt ?? new Date().toISOString(),
  };
}
