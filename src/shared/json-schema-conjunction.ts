// Conjunction of two JSON Schemas for one property, used where a publisher has to
// state "both of these hold" as a single property schema.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readLiteralSchemaValues,
  schemaAnnotationsOnly,
  schemaValidationKeywordsOnly,
} from "./json-schema-literals.js";

/** `type` lists the JSON types a value may take; absent or malformed is unknown. */
export function readSchemaTypeNames(value: unknown): Set<string> | undefined {
  if (typeof value === "string") {
    return new Set([value]);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return new Set(value as string[]);
  }
  return undefined;
}

// `integer` accepts a strict subset of `number`, so naming both is a narrowing to
// the subtype rather than the disjoint pair the literal type names suggest.
const TYPE_NAME_SUPERTYPES = new Map([["integer", "number"]]);

function keepNarrowerTypeNames(from: Set<string>, against: Set<string>, kept: string[]) {
  for (const name of from) {
    if (kept.includes(name)) {
      continue;
    }
    if (against.has(name) || against.has(TYPE_NAME_SUPERTYPES.get(name) ?? name)) {
      kept.push(name);
    }
  }
}

function intersectTypeKeyword(left: unknown, right: unknown): unknown {
  const leftNames = readSchemaTypeNames(left);
  const rightNames = readSchemaTypeNames(right);
  if (!leftNames || !rightNames) {
    return undefined;
  }
  const kept: string[] = [];
  keepNarrowerTypeNames(leftNames, rightNames, kept);
  keepNarrowerTypeNames(rightNames, leftNames, kept);
  if (kept.length === 0) {
    return undefined;
  }
  return kept.length === 1 ? kept[0] : kept;
}

// Keywords whose assertion reads only the instance, so a conjunction may hold
// them side by side in one schema. Everything else - `properties`,
// `additionalProperties`, `items`, `if`/`then`, nested composition - is evaluated
// against its own schema's siblings, so copying it into another schema changes
// what that schema accepts.
const SELF_CONTAINED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

function literalKeywordsOnly(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key === "const" || key === "enum"),
  );
}

// `const` and `enum` constrain one value set, so the conjunction keeps the values
// both sides admit. Undefined means no value satisfies both.
function intersectLiteralKeywords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const leftValues = readLiteralSchemaValues(left);
  const rightValues = readLiteralSchemaValues(right);
  if (!leftValues && !rightValues) {
    return {};
  }
  if (!rightValues) {
    return literalKeywordsOnly(left);
  }
  if (!leftValues) {
    return literalKeywordsOnly(right);
  }
  const kept = leftValues.filter((value) =>
    rightValues.some((candidate) => isDeepStrictEqual(candidate, value, { skipPrototype: true })),
  );
  return kept.length > 0 ? { enum: kept } : undefined;
}

// Annotations document a property instead of constraining it, so differing ones
// never make a conjunction unsatisfiable. The left schema wins so the published
// metadata is deterministic.
function combineAnnotations(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  return { ...schemaAnnotationsOnly(right), ...schemaAnnotationsOnly(left) };
}

// One flat schema can carry the conjunction exactly when both sides constrain
// only self-contained keywords and every keyword they share has an exact
// intersection. Undefined means the caller must keep the conjunct boundary.
function flatIntersection(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const leftConstraints = schemaValidationKeywordsOnly(left);
  const rightConstraints = schemaValidationKeywordsOnly(right);
  const shared = [...Object.keys(leftConstraints), ...Object.keys(rightConstraints)];
  if (!shared.every((keyword) => SELF_CONTAINED_KEYWORDS.has(keyword))) {
    return undefined;
  }
  const literals = intersectLiteralKeywords(left, right);
  if (!literals) {
    return undefined;
  }
  const merged: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(leftConstraints)) {
    if (keyword !== "const" && keyword !== "enum") {
      merged[keyword] = value;
    }
  }
  for (const [keyword, value] of Object.entries(rightConstraints)) {
    if (keyword === "const" || keyword === "enum") {
      continue;
    }
    if (!Object.hasOwn(merged, keyword)) {
      merged[keyword] = value;
      continue;
    }
    if (isDeepStrictEqual(merged[keyword], value, { skipPrototype: true })) {
      continue;
    }
    const narrowed = keyword === "type" ? intersectTypeKeyword(merged[keyword], value) : undefined;
    if (narrowed === undefined) {
      return undefined;
    }
    merged[keyword] = narrowed;
  }
  return { ...combineAnnotations(left, right), ...merged, ...literals };
}

// Our own nested conjunctions are spliced so repeated combines stay one level
// deep. A caller-supplied `allOf` is kept intact unless every branch is an object
// schema, because a `false` branch there admits nothing.
function conjunctsOf(schema: Record<string, unknown>): Record<string, unknown>[] {
  const constraints = schemaValidationKeywordsOnly(schema);
  const keywords = Object.keys(constraints);
  if (keywords.length === 0) {
    return [];
  }
  if (keywords.length === 1 && keywords[0] === "allOf" && Array.isArray(constraints.allOf)) {
    const branches = constraints.allOf;
    if (branches.length > 0 && branches.every((branch) => isRecord(branch))) {
      return branches as Record<string, unknown>[];
    }
  }
  return [constraints];
}

// Each conjunct keeps its own evaluation scope, so no keyword is read against a
// sibling it was not written with. Nested composition under a property is legal
// in a native tool input schema - only the root is restricted to one object.
function nestedConjunction(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const annotations = combineAnnotations(left, right);
  const conjuncts = [...conjunctsOf(left), ...conjunctsOf(right)];
  if (conjuncts.length <= 1) {
    return { ...annotations, ...conjuncts[0] };
  }
  return { ...annotations, allOf: conjuncts };
}

/**
 * Return the schema accepting exactly the values both sides accept.
 *
 * Flat where one schema can state both constraints exactly, and a nested
 * `allOf` otherwise, so a property is never published with a weakened
 * constraint and never withheld for lack of a flat projection.
 */
export function intersectPropertySchemas(
  left: boolean | Record<string, unknown>,
  right: boolean | Record<string, unknown>,
): boolean | Record<string, unknown> {
  if (left === true) {
    return right;
  }
  if (right === true) {
    return left;
  }
  if (left === false || right === false) {
    return false;
  }
  if (isDeepStrictEqual(left, right, { skipPrototype: true })) {
    return left;
  }
  return flatIntersection(left, right) ?? nestedConjunction(left, right);
}
