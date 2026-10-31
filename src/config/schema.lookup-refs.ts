import { isDeepStrictEqual } from "node:util";
import { parseLocalSchemaRefPointer } from "@openclaw/normalization-core/json-schema";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  asSchemaObject,
  type ConfigJsonSchemaObject as JsonSchemaObject,
} from "./schema.shared.js";

export const LOOKUP_SCHEMA_COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const MAX_LOOKUP_REFERENCE_HOPS = 32;
// Shared definitions can fan out (each tuple item referencing the next definition),
// so one traversal stops after this many dereferences or referenced nodes.
const MAX_LOOKUP_REFERENCE_EXPANSIONS = 256;
export const MAX_LOOKUP_REFERENCED_NODES = 2_048;
// Siblings of $ref may relabel the referenced schema; every other keyword constrains
// the value together with the target, as the plugin validator applies both.
const LOOKUP_REFERENCE_ANNOTATION_KEYS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);
const LOOKUP_LOWER_BOUND_KEYS = new Set([
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
]);
const LOOKUP_UPPER_BOUND_KEYS = new Set([
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
]);

export type LookupExpansionBudget = { remaining: number };

export function createLookupExpansionBudget(
  limit = MAX_LOOKUP_REFERENCE_EXPANSIONS,
): LookupExpansionBudget {
  return { remaining: limit };
}

export type LookupSchemaNode = {
  schema: JsonSchemaObject;
  referenceRoot: JsonSchemaObject | null;
  identity: JsonSchemaObject;
};

// A boolean schema accepts everything (true) or nothing (false).
function toSchemaObject(value: unknown): JsonSchemaObject {
  return asSchemaObject(value) ?? (value === false ? { not: {} } : {});
}

function withConstraint(schema: JsonSchemaObject, constraint: unknown): JsonSchemaObject {
  return { ...schema, allOf: [...(schema.allOf ?? []), toSchemaObject(constraint)] };
}

/** Applies the keywords beside a $ref to its target without loosening either schema. */
function mergeReferenceSiblings(
  target: JsonSchemaObject,
  siblings: JsonSchemaObject,
): JsonSchemaObject {
  const merged: JsonSchemaObject = { ...target };
  const residual: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(siblings)) {
    const existing = merged[key];
    if (
      !Object.hasOwn(merged, key) ||
      LOOKUP_REFERENCE_ANNOTATION_KEYS.has(key) ||
      isDeepStrictEqual(existing, value)
    ) {
      merged[key] = value;
    } else if (
      typeof existing === "number" &&
      typeof value === "number" &&
      (LOOKUP_LOWER_BOUND_KEYS.has(key) || LOOKUP_UPPER_BOUND_KEYS.has(key))
    ) {
      merged[key] = LOOKUP_LOWER_BOUND_KEYS.has(key)
        ? Math.max(existing, value)
        : Math.min(existing, value);
    } else if (key === "required" && Array.isArray(existing) && Array.isArray(value)) {
      merged.required = [...new Set([...existing, ...value])];
    } else if (key === "properties" && asSchemaObject(existing) && asSchemaObject(value)) {
      const properties = { ...merged.properties };
      for (const [name, child] of Object.entries(asSchemaObject(value) ?? {})) {
        properties[name] = Object.hasOwn(properties, name)
          ? withConstraint(toSchemaObject(properties[name]), child)
          : toSchemaObject(child);
      }
      merged.properties = properties;
    } else {
      residual[key] = value;
    }
  }
  return Object.keys(residual).length > 0 ? withConstraint(merged, residual) : merged;
}

export function resolveLookupSchemaNode(
  schema: JsonSchemaObject,
  referenceRoot: JsonSchemaObject | null = null,
  budget?: LookupExpansionBudget,
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
    if (
      !target ||
      seen.has(target) ||
      seen.size >= MAX_LOOKUP_REFERENCE_HOPS ||
      (budget && budget.remaining <= 0)
    ) {
      return null;
    }
    if (budget) {
      budget.remaining -= 1;
    }
    seen.add(target);
    const { $ref: _ref, ...siblings } = current;
    current =
      Object.keys(siblings).length === 0 ? target : mergeReferenceSiblings(target, siblings);
    identity = target;
  }
}

export function lookupSchemaHasChildren(
  node: LookupSchemaNode,
  seen = new Set<JsonSchemaObject>(),
  budget = createLookupExpansionBudget(),
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
      const child = resolveLookupSchemaNode(variant, node.referenceRoot, budget);
      return child ? lookupSchemaHasChildren(child, visited, budget) : false;
    }),
  );
}
