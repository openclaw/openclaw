import { parseLocalSchemaRefPointer } from "@openclaw/normalization-core/json-schema";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  asSchemaObject,
  type ConfigJsonSchemaObject as JsonSchemaObject,
} from "./schema.shared.js";

export const LOOKUP_SCHEMA_COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const MAX_LOOKUP_REFERENCE_HOPS = 32;

export type LookupSchemaNode = {
  schema: JsonSchemaObject;
  referenceRoot: JsonSchemaObject | null;
  identity: JsonSchemaObject;
};

export function resolveLookupSchemaNode(
  schema: JsonSchemaObject,
  referenceRoot: JsonSchemaObject | null = null,
): LookupSchemaNode | null {
  let current = schema;
  let identity = schema;
  let root = referenceRoot;
  const seen = new Set<JsonSchemaObject>();

  while (true) {
    // The first definitions owner identifies a mounted plugin fragment. Nested
    // definitions do not create a resource; an explicit $id does.
    if (
      typeof current.$id === "string" ||
      (!root && (Object.hasOwn(current, "$defs") || Object.hasOwn(current, "definitions")))
    ) {
      root = current;
    }
    if (typeof current.$ref !== "string") {
      return { schema: current, referenceRoot: root, identity };
    }
    const pointer = parseLocalSchemaRefPointer(current.$ref);
    const [definitionsKey, name] = pointer ?? [];
    if (
      pointer?.length !== 2 ||
      (definitionsKey !== "$defs" && definitionsKey !== "definitions") ||
      name === undefined
    ) {
      return { schema: current, referenceRoot: root, identity };
    }
    const definitions =
      root && Object.hasOwn(root, definitionsKey) ? asSchemaObject(root[definitionsKey]) : null;
    const target =
      definitions && !isBlockedObjectKey(name) && Object.hasOwn(definitions, name)
        ? asSchemaObject(definitions[name])
        : null;
    if (!target || seen.has(target) || seen.size >= MAX_LOOKUP_REFERENCE_HOPS) {
      return null;
    }
    seen.add(target);
    const { $ref: _ref, ...siblings } = current;
    current = Object.keys(siblings).length === 0 ? target : { ...target, ...siblings };
    identity = target;
  }
}

export function lookupSchemaHasChildren(
  node: LookupSchemaNode,
  seen = new Set<JsonSchemaObject>(),
): boolean {
  if (seen.has(node.identity)) {
    return false;
  }
  const { schema } = node;
  if (
    (schema.properties && Object.keys(schema.properties).length > 0) ||
    (schema.additionalProperties && typeof schema.additionalProperties === "object") ||
    (Array.isArray(schema.items)
      ? schema.items.some((entry) => entry && typeof entry === "object")
      : schema.items && typeof schema.items === "object")
  ) {
    return true;
  }
  const visited = new Set(seen).add(node.identity);
  return LOOKUP_SCHEMA_COMPOSITION_KEYS.some((key) =>
    schema[key]?.some((variant) => {
      const child = resolveLookupSchemaNode(variant, node.referenceRoot);
      return child ? lookupSchemaHasChildren(child, visited) : false;
    }),
  );
}
