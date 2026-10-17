import { validateToolArguments } from "@openclaw/llm-core/validation";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { AnyAgentTool, ProviderNormalizeToolSchemasContext } from "./plugin-entry.js";
import { buildProviderToolCompatFamilyHooks } from "./provider-tools.js";

function tool(parameters: AnyAgentTool["parameters"], name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters,
    execute: async () => {
      throw new Error("Schema tests must not execute tools");
    },
  };
}

function deepSeekContext(tools: AnyAgentTool[]): ProviderNormalizeToolSchemasContext {
  return {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    modelApi: "openai-completions",
    tools,
  };
}

function validateDeepSeekTool(normalized: AnyAgentTool[], args: Record<string, unknown>) {
  const normalizedTool = expectDefined(normalized[0], "normalized DeepSeek tool");
  return validateToolArguments(normalizedTool, {
    type: "toolCall",
    id: "call-deepseek-probe",
    name: normalizedTool.name,
    arguments: args,
  });
}

const parentVariant = (kind: string, id: string) => ({
  type: "object",
  properties: { kind: { type: "string", enum: [kind] }, [id]: { type: "string" } },
  required: ["kind", id],
  additionalProperties: false,
});
const nullablePage = parentVariant("page", "page_id");
const nullableDatabase = parentVariant("database", "database_id");
const pageParent = { kind: "page", page_id: "page-1" };
const databaseParent = { kind: "database", database_id: "database-1" };
const nullSchema = { type: "null" };
const schemaCase = (
  name: string,
  parentSchema: Record<string, unknown>,
  acceptsNull = true,
  validParents: object[] = [pageParent, databaseParent],
) => ({ name, parentSchema, acceptsNull, validParents });

function assertParents(
  parentSchema: Record<string, unknown>,
  acceptsNull: boolean,
  validParents: object[],
  invalidParents: unknown[],
) {
  const hooks = buildProviderToolCompatFamilyHooks("deepseek");
  const normalized = hooks.normalizeToolSchemas(
    deepSeekContext([
      tool(
        { type: "object", properties: { parent: parentSchema }, required: ["parent"] },
        "parent",
      ),
    ]),
  );
  expect(hooks.inspectToolSchemas(deepSeekContext(normalized))).toStrictEqual([]);
  const validate = (parent: unknown) => validateDeepSeekTool(normalized, { parent });
  if (acceptsNull) {
    expect(validate(null)).toEqual({ parent: null });
  } else {
    expect(() => validate(null)).toThrow(/Validation failed for tool "parent"/);
  }
  for (const parent of validParents) {
    expect(validate(parent)).toEqual({ parent });
  }
  for (const parent of invalidParents) {
    expect(() => validate(parent)).toThrow(/Validation failed for tool "parent"/);
  }
  return normalized;
}

it.each([
  schemaCase("one object and null", { oneOf: [nullablePage, nullSchema] }, true, [pageParent]),
  schemaCase("multiple objects and null", {
    anyOf: [nullablePage, nullableDatabase, nullSchema],
  }),
  schemaCase("a nullable object branch and another object", {
    anyOf: [{ anyOf: [nullablePage, nullSchema] }, nullableDatabase],
  }),
  schemaCase(
    "an explicit outer object constraint",
    {
      type: "object",
      anyOf: [nullablePage, nullableDatabase, nullSchema],
    },
    false,
  ),
  schemaCase(
    "a nullable type whose literal restriction excludes null",
    {
      anyOf: [{ ...nullablePage, type: ["object", "null"], enum: [pageParent] }, nullableDatabase],
    },
    false,
  ),
])(
  "validates nested object alternatives with $name",
  ({ parentSchema, acceptsNull, validParents }) => {
    const normalized = assertParents(parentSchema, acceptsNull, validParents, [
      false,
      0,
      "",
      {},
      { kind: "unknown" },
      "not an object",
    ]);
    expect(() => validateDeepSeekTool(normalized, {})).toThrow(
      /Validation failed for tool "parent"/,
    );
  },
);

const otherPageParent = { kind: "page", page_id: "page-2" };

const both = [pageParent, otherPageParent];
const branchEnum = { enum: both };
const literalCase = (
  name: string,
  branch: Record<string, unknown>,
  outer: Record<string, unknown> = {},
  acceptsNull = true,
  acceptsPage = true,
) => ({
  name,
  branch,
  outer,
  acceptsNull,
  validParents: acceptsPage ? [pageParent] : [],
  invalidParents: acceptsPage ? [otherPageParent] : both,
});
it.each([
  literalCase("a branch-local enum", { enum: [pageParent] }),
  literalCase("a branch-local const", { const: pageParent }),
  literalCase("an intersecting branch-local const and enum", { const: pageParent, enum: both }),
  literalCase(
    "a disjoint branch-local const and enum",
    { const: pageParent, enum: [otherPageParent] },
    {},
    true,
    false,
  ),
  literalCase("an outer enum excluding null", branchEnum, { enum: [pageParent] }, false),
  literalCase("an outer enum allowing null", branchEnum, { enum: [pageParent, null] }),
  literalCase("an outer object const", branchEnum, { const: pageParent }, false),
  literalCase("an outer null const", branchEnum, { const: null }, true, false),
])(
  "preserves object/null literal restrictions with $name",
  ({ branch, outer, acceptsNull, validParents, invalidParents }) => {
    assertParents(
      { anyOf: [{ ...nullablePage, ...branch }, nullSchema], ...outer },
      acceptsNull,
      validParents,
      [...invalidParents, false, 0, ""],
    );
  },
);
