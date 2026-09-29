import { validateToolArguments } from "@openclaw/llm-core/validation";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool, ProviderNormalizeToolSchemasContext } from "./plugin-entry.js";
import { buildProviderToolCompatFamilyHooks } from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
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

  function objectSchema(
    properties: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    return { type: "object", properties, ...overrides };
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

  const nullablePage = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["page"] },
      page_id: { type: "string" },
    },
    required: ["kind", "page_id"],
    additionalProperties: false,
  };
  const nullableDatabase = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["database"] },
      database_id: { type: "string" },
    },
    required: ["kind", "database_id"],
    additionalProperties: false,
  };
  const pageParent = { kind: "page", page_id: "page-1" };
  const databaseParent = { kind: "database", database_id: "database-1" };

  it.each([
    {
      name: "one object and null",
      parentSchema: { oneOf: [nullablePage, { type: "null" }] },
      acceptsNull: true,
      validParents: [pageParent],
    },
    {
      name: "multiple objects and null",
      parentSchema: { anyOf: [nullablePage, nullableDatabase, { type: "null" }] },
      acceptsNull: true,
      validParents: [pageParent, databaseParent],
    },
    {
      name: "a nullable object branch and another object",
      parentSchema: { anyOf: [{ anyOf: [nullablePage, { type: "null" }] }, nullableDatabase] },
      acceptsNull: true,
      validParents: [pageParent, databaseParent],
    },
    {
      name: "an explicit outer object constraint",
      parentSchema: {
        type: "object",
        anyOf: [nullablePage, nullableDatabase, { type: "null" }],
      },
      acceptsNull: false,
      validParents: [pageParent, databaseParent],
    },
    {
      name: "a nullable type whose literal restriction excludes null",
      parentSchema: {
        anyOf: [
          { ...nullablePage, type: ["object", "null"], enum: [pageParent] },
          nullableDatabase,
        ],
      },
      acceptsNull: false,
      validParents: [pageParent, databaseParent],
    },
  ])(
    "validates nested object alternatives with $name",
    ({ parentSchema, acceptsNull, validParents }) => {
      const hooks = buildProviderToolCompatFamilyHooks("deepseek");
      const normalized = hooks.normalizeToolSchemas(
        deepSeekContext([
          tool(objectSchema({ parent: parentSchema }, { required: ["parent"] }), "nullable-parent"),
        ]),
      );
      expect(hooks.inspectToolSchemas(deepSeekContext(normalized))).toStrictEqual([]);
      if (acceptsNull) {
        expect(validateDeepSeekTool(normalized, { parent: null })).toEqual({ parent: null });
      } else {
        expect(() => validateDeepSeekTool(normalized, { parent: null })).toThrow(
          /Validation failed for tool "nullable-parent"/,
        );
      }
      for (const parent of validParents) {
        expect(validateDeepSeekTool(normalized, { parent })).toEqual({ parent });
      }
      for (const args of [
        {},
        { parent: false },
        { parent: 0 },
        { parent: "" },
        { parent: {} },
        { parent: { kind: "unknown" } },
        { parent: "not an object" },
      ]) {
        expect(() => validateDeepSeekTool(normalized, args)).toThrow(
          /Validation failed for tool "nullable-parent"/,
        );
      }
    },
  );

  const otherPageParent = { kind: "page", page_id: "page-2" };

  it.each([
    {
      name: "a branch-local enum",
      branch: { enum: [pageParent] },
      outer: {},
      acceptsNull: true,
      validParents: [pageParent],
      invalidParents: [otherPageParent],
    },
    {
      name: "a branch-local const",
      branch: { const: pageParent },
      outer: {},
      acceptsNull: true,
      validParents: [pageParent],
      invalidParents: [otherPageParent],
    },
    {
      name: "an intersecting branch-local const and enum",
      branch: { const: pageParent, enum: [pageParent, otherPageParent] },
      outer: {},
      acceptsNull: true,
      validParents: [pageParent],
      invalidParents: [otherPageParent],
    },
    {
      name: "a disjoint branch-local const and enum",
      branch: { const: pageParent, enum: [otherPageParent] },
      outer: {},
      acceptsNull: true,
      validParents: [],
      invalidParents: [pageParent, otherPageParent],
    },
    {
      name: "an outer enum excluding null",
      branch: { enum: [pageParent, otherPageParent] },
      outer: { enum: [pageParent] },
      acceptsNull: false,
      validParents: [pageParent],
      invalidParents: [otherPageParent],
    },
    {
      name: "an outer enum allowing null",
      branch: { enum: [pageParent, otherPageParent] },
      outer: { enum: [pageParent, null] },
      acceptsNull: true,
      validParents: [pageParent],
      invalidParents: [otherPageParent],
    },
    {
      name: "an outer object const",
      branch: { enum: [pageParent, otherPageParent] },
      outer: { const: pageParent },
      acceptsNull: false,
      validParents: [pageParent],
      invalidParents: [otherPageParent],
    },
    {
      name: "an outer null const",
      branch: { enum: [pageParent, otherPageParent] },
      outer: { const: null },
      acceptsNull: true,
      validParents: [],
      invalidParents: [pageParent, otherPageParent],
    },
  ])("preserves object/null literal restrictions with $name", (testCase) => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const normalized = hooks.normalizeToolSchemas(
      deepSeekContext([
        tool(
          objectSchema(
            {
              parent: {
                anyOf: [{ ...nullablePage, ...testCase.branch }, { type: "null" }],
                ...testCase.outer,
              },
            },
            { required: ["parent"] },
          ),
          "literal-null-parent",
        ),
      ]),
    );

    expect(hooks.inspectToolSchemas(deepSeekContext(normalized))).toStrictEqual([]);
    if (testCase.acceptsNull) {
      expect(validateDeepSeekTool(normalized, { parent: null })).toEqual({ parent: null });
    } else {
      expect(() => validateDeepSeekTool(normalized, { parent: null })).toThrow(
        /Validation failed for tool "literal-null-parent"/,
      );
    }
    for (const parent of testCase.validParents) {
      expect(validateDeepSeekTool(normalized, { parent })).toEqual({ parent });
    }
    for (const parent of [...testCase.invalidParents, false, 0, ""]) {
      expect(() => validateDeepSeekTool(normalized, { parent })).toThrow(
        /Validation failed for tool "literal-null-parent"/,
      );
    }
  });
});
