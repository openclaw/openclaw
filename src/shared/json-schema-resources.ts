import {
  decodeLocalSchemaRefFragment,
  mapJsonSchema,
  normalizeJsonSchemaForTypeBox,
  prepareJsonSchemaFormats,
  type JsonSchemaRefinement,
  type JsonSchemaValue,
} from "@openclaw/normalization-core/json-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import fastUri from "fast-uri";
import { splitResourceRef } from "./json-schema-defaults.js";

function stripFragment(id: string): string {
  return splitResourceRef(id).resource;
}

/** Normalize an ID while preserving draft-07 fragment anchors. */
export function resolveJsonSchemaResourceId(id: string, baseId: string | undefined): string {
  let resolved = id;
  if (baseId) {
    try {
      resolved = fastUri.resolve(baseId, id);
    } catch {
      // Relative IDs without an absolute base remain valid context keys.
    }
  }
  return resolved.endsWith("#") ? resolved.slice(0, -1) : resolved;
}

/** Index only schema resources; IDs embedded in defaults, enums, or examples are data. */
export function collectJsonSchemaResources(
  schema: JsonSchemaValue,
  options: { rejectDuplicateIds?: boolean } = {},
): Map<string, JsonSchemaValue> {
  const resources = new Map<string, JsonSchemaValue>();
  const bases = new WeakMap<object, string | undefined>();
  mapJsonSchema(schema, (node, ancestors) => {
    const parent = ancestors.at(-1);
    const baseId = parent ? bases.get(parent) : undefined;
    const id =
      typeof node.$id === "string" ? resolveJsonSchemaResourceId(node.$id, baseId) : undefined;
    const nextBase = id === undefined ? baseId : stripFragment(id);
    bases.set(node, nextBase);
    const register = (resourceId: string) => {
      if (
        options.rejectDuplicateIds &&
        resources.has(resourceId) &&
        !(ancestors.length === 0 && resources.get(resourceId) === node)
      ) {
        throw new Error(`JSON Schema reference resolves to more than one schema: ${resourceId}`);
      }
      resources.set(resourceId, node);
    };
    if (id !== undefined) {
      register(id);
    }
    for (const anchor of [node.$anchor, node.$dynamicAnchor]) {
      if (typeof anchor === "string") {
        register(`${nextBase ?? ""}#${anchor}`);
      }
    }
    return node;
  });
  return resources;
}

const validationResourceBase = "https://schemas.openclaw.invalid/";

/** TypeBox requires a hierarchical base for relative resources; this URI is never fetched. */
export function resolveJsonSchemaValidationId(id: string): string {
  return resolveJsonSchemaResourceId(id, validationResourceBase);
}

/** Keep source schemas intact while sharing one reference/format preparation policy. */
export function prepareJsonSchemaWithResources(
  source: JsonSchemaValue,
  formats: ReadonlyMap<string, JsonSchemaRefinement>,
): { schema: JsonSchemaValue; resources: Map<string, JsonSchemaValue> } {
  const normalized = normalizeJsonSchemaForTypeBox(prepareJsonSchemaFormats(source, formats));
  const prepared = mapJsonSchema(normalized, (node) => {
    if (typeof node.pattern === "string") {
      const pattern = new RegExp(node.pattern, "u");
      void pattern;
    }
    if (isRecord(node.patternProperties)) {
      for (const text of Object.keys(node.patternProperties)) {
        const pattern = new RegExp(text, "u");
        void pattern;
      }
    }
    if (typeof node.$id === "string" && node.$id.startsWith("#")) {
      const anchor = decodeLocalSchemaRefFragment(node.$id);
      if (anchor !== undefined && !anchor.startsWith("/")) {
        const { $id: _id, ...rest } = node;
        return anchor ? { ...rest, $anchor: anchor } : rest;
      }
    }
    return node;
  });
  if (!isRecord(prepared)) {
    return { schema: prepared, resources: new Map() };
  }
  const rootId = resolveJsonSchemaValidationId(
    isRecord(source) && typeof source.$id === "string" ? source.$id : "",
  );
  const { resource, fragment } = splitResourceRef(rootId);
  const anchor = fragment ? decodeLocalSchemaRefFragment(fragment) : undefined;
  const schema = {
    ...prepared,
    $id: resource,
    ...(anchor && !anchor.startsWith("/") ? { $anchor: anchor } : {}),
  };
  const resources = collectJsonSchemaResources(schema);
  resources.set(rootId, schema);
  return { schema, resources };
}
