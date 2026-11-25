import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { analyzeConfigSchema } from "../../ui/src/components/config-form.analyze.js";
import { isSupportedConfigValueValid } from "../../ui/src/components/config-form.constraints.js";
import type { JsonSchema } from "../../ui/src/components/config-form.shared.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

type MixedUnion = [path: string, schema: JsonSchema, literals: unknown[]];

function branches(schema: JsonSchema): JsonSchema[] {
  return [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
}

function literalValues(schema: JsonSchema): unknown[] | undefined {
  return Array.isArray(schema.enum)
    ? schema.enum
    : Object.hasOwn(schema, "const")
      ? [schema.const]
      : schema.type === "null"
        ? [null]
        : undefined;
}

function collectMixedUnions(schema: JsonSchema, path: string[] = [], result: MixedUnion[] = []) {
  const values = (schema.anyOf ?? schema.oneOf)?.map(literalValues) ?? [];
  const literals = values.flatMap((value) => value ?? []);
  if (literals.length > 0 && values.includes(undefined)) {
    result.push([path.join(".") || "<root>", schema, literals]);
  }

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    collectMixedUnions(child, [...path, key], result);
  }
  const items = schema.items;
  if (Array.isArray(items)) {
    items.forEach((item, index) => collectMixedUnions(item, [...path, String(index)], result));
  } else if (items) {
    collectMixedUnions(items, [...path, "*"], result);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    collectMixedUnions(schema.additionalProperties, [...path, "*"], result);
  }
  for (const branch of branches(schema)) {
    collectMixedUnions(branch, path, result);
  }
  return result;
}

function schemaChildAtSegment(schema: JsonSchema, segment: string): JsonSchema | undefined {
  const items = schema.items;
  const additional =
    typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
  const direct =
    segment === "*"
      ? Array.isArray(items)
        ? undefined
        : items || additional
      : /^\d+$/u.test(segment) && Array.isArray(items)
        ? items[Number(segment)]
        : schema.properties?.[segment];
  return (
    direct ??
    branches(schema).reduce<JsonSchema | undefined>(
      (found, branch) => found ?? schemaChildAtSegment(branch, segment),
      undefined,
    )
  );
}

function schemaAtPath(schema: JsonSchema, path: string): JsonSchema | undefined {
  return (path === "<root>" ? [] : path.split(".")).reduce<JsonSchema | undefined>(
    (current, segment) => current && schemaChildAtSegment(current, segment),
    schema,
  );
}

function isPathUnsupported(path: string, unsupportedPaths: string[]): boolean {
  return unsupportedPaths.some(
    (root) => root === "<root>" || path === root || path.startsWith(`${root}.`),
  );
}

function analyze() {
  const rawSchema = computeBaseConfigSchemaResponse({
    generatedAt: "fixture",
  }).schema as JsonSchema;
  return { rawSchema, ...analyzeConfigSchema(rawSchema) };
}

it("never drops accepted literals from mixed unions", () => {
  const analysis = analyze();
  const { rawSchema } = analysis;
  const mixedUnions = collectMixedUnions(rawSchema);

  expect(mixedUnions.length).toBeGreaterThan(0);
  const lossyPaths = mixedUnions.flatMap(([path, schema, literals]) => {
    if (isPathUnsupported(path, analysis.unsupportedPaths)) {
      return [];
    }
    const analyzedSchema = analysis.schema ? schemaAtPath(analysis.schema, path) : undefined;
    return literals
      .filter((literal) => Value.Check(schema as never, literal))
      .filter((literal) => !analyzedSchema || !isSupportedConfigValueValid(analyzedSchema, literal))
      .map(() => path);
  });

  expect([...new Set(lossyPaths)].toSorted()).toEqual([]);
});

it("keeps native command settings editable as tri-state controls", () => {
  const analysis = analyze();

  for (const path of ["commands.native", "commands.nativeSkills"]) {
    expect(isPathUnsupported(path, analysis.unsupportedPaths)).toBe(false);
    expect(analysis.schema ? schemaAtPath(analysis.schema, path) : undefined).toMatchObject({
      enum: [true, false, "auto"],
      default: "auto",
    });
  }
});
