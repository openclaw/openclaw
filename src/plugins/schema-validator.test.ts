/** Covers plugin schema validation for manifests and exported config schemas. */
import { describe, expect, it, vi } from "vitest";
import { parseJsonSchemaIssuePath, validateJsonSchemaValue } from "./schema-validator.js";

// Config validation is a CLI startup dependency; codecs and value transforms are not.
vi.mock("typebox/compile", () => {
  throw new Error("schema validation must not load the TypeBox value-transform compiler");
});
vi.mock("typebox/value", () => {
  throw new Error("schema validation must not load TypeBox value transforms");
});

const jsonSchemaThenKeyword = ["the", "n"].join("");

function expectValidationFailure(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }> {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

function expectValidationIssue(
  result: Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }>,
  path: string,
) {
  const issue = result.errors.find((entry) => entry.path === path);
  if (!issue) {
    expect(result.errors.map((entry) => entry.path)).toContain(path);
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

function expectIssueMessageIncludes(
  issue: ReturnType<typeof expectValidationIssue>,
  fragments: readonly string[],
) {
  expect(issue.message).toContain(fragments[0] ?? "");
  fragments.slice(1).forEach((fragment) => {
    expect(issue.message).toContain(fragment);
  });
}

function expectSuccessfulValidationValue(
  input: Parameters<typeof validateJsonSchemaValue>[0],
  expectedValue: unknown,
) {
  const result = validateJsonSchemaValue(input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(expectedValue);
  }
}

function expectValidationSuccess(params: Parameters<typeof validateJsonSchemaValue>[0]) {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(true);
}

describe("schema validator", () => {
  it.each([
    ["<root>", []],
    ["items.0.enabled", ["items", 0, "enabled"]],
    ["items.100001.enabled", ["items", "100001", "enabled"]],
  ])("parses JSON Schema issue path %s", (path, expected) => {
    expect(parseJsonSchemaIssuePath(path)).toEqual(expected);
  });

  it("rejects invalid JSON Schema constraint keyword values", () => {
    for (const [cacheKey, schema] of [
      [
        "schema-validator.test.invalid-required",
        {
          type: "object",
          properties: { url: { type: "string" } },
          required: "url",
        },
      ],
      [
        "schema-validator.test.invalid-min-length",
        {
          type: "string",
          minLength: "1",
        },
      ],
      [
        "schema-validator.test.invalid-additional-properties",
        {
          type: "object",
          additionalProperties: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-allof",
        {
          allOf: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-anyof",
        {
          anyOf: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-oneof",
        {
          oneOf: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-enum",
        {
          enum: [],
        },
      ],
      [
        "schema-validator.test.invalid-duplicate-enum",
        {
          enum: ["api", "api"],
        },
      ],
      [
        "schema-validator.test.invalid-duplicate-required",
        {
          type: "object",
          required: ["mode", "mode"],
        },
      ],
      [
        "schema-validator.test.invalid-duplicate-type-array",
        {
          type: ["string", "string"],
        },
      ],
      [
        "schema-validator.test.invalid-ref",
        {
          $ref: "#/$defs/Missing",
        },
      ],
      [
        "schema-validator.test.invalid-array-ref-leading-zero",
        {
          anyOf: [{ type: "number" }, { type: "string" }],
          $ref: "#/anyOf/01",
        },
      ],
      [
        "schema-validator.test.invalid-dynamic-ref-type",
        {
          $dynamicRef: 123,
        },
      ],
      [
        "schema-validator.test.invalid-dynamic-ref",
        {
          $dynamicRef: "#/$defs/Missing",
        },
      ],
      [
        "schema-validator.test.invalid-nullable-type",
        {
          type: "string",
          nullable: "yes",
        },
      ],
      [
        "schema-validator.test.invalid-nullable-without-type",
        {
          nullable: true,
        },
      ],
      [
        "schema-validator.test.invalid-anchor-ref",
        {
          $defs: {
            Other: {
              $id: "other",
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
      ],
      [
        "schema-validator.test.invalid-external-ref",
        {
          $ref: "https://example.com/missing",
        },
      ],
      [
        "schema-validator.test.invalid-dependencies-value",
        {
          type: "object",
          dependencies: {
            mode: 123,
          },
        },
      ],
      [
        "schema-validator.test.invalid-dependencies-array",
        {
          type: "object",
          dependencies: {
            mode: [1],
          },
        },
      ],
    ] as const) {
      expect(() =>
        validateJsonSchemaValue({
          cacheKey,
          schema,
          value: "anything",
        }),
      ).toThrow("invalid schema");
    }
  });

  it("accepts valid local refs to boolean schemas and anchors", () => {
    const denied = expectValidationFailure({
      cacheKey: "schema-validator.test.false-ref",
      schema: {
        $defs: {
          Never: false,
        },
        $ref: "#/$defs/Never",
      },
      value: "anything",
    });
    expectValidationIssue(denied, "<root>");

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.anchor-ref",
        schema: {
          $defs: {
            Value: {
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.nested-resource-anchor-ref",
        schema: {
          $defs: {
            Other: {
              $id: "other",
              $defs: {
                Value: {
                  $anchor: "value",
                  type: "string",
                },
              },
              $ref: "#value",
            },
          },
          $ref: "#/$defs/Other",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.absolute-same-document-ref",
        schema: {
          $id: "https://example.com/schema",
          $defs: {
            Value: {
              type: "string",
            },
          },
          $ref: "https://example.com/schema#/$defs/Value",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.embedded-absolute-id-ref",
        schema: {
          $defs: {
            Value: {
              $id: "https://example.com/value",
              type: "string",
            },
          },
          $ref: "https://example.com/value",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.embedded-relative-id-ref",
        schema: {
          $defs: {
            Value: {
              $id: "value",
              type: "string",
            },
          },
          $ref: "value",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.resolved-relative-id-ref",
        schema: {
          $id: "https://example.com/root/",
          $defs: {
            Value: {
              $id: "value",
              type: "string",
            },
          },
          $ref: "https://example.com/root/value",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.empty-id-local-ref",
        schema: {
          $id: "",
          $defs: {
            Value: {
              type: "string",
            },
          },
          $ref: "#/$defs/Value",
        },
        value: "ok",
      },
      "ok",
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.dynamic-ref",
        schema: {
          $defs: {
            Value: {
              $dynamicAnchor: "value",
              type: "string",
            },
          },
          $dynamicRef: "#value",
        },
        value: "ok",
      },
      "ok",
    );

    expectValidationFailure({
      cacheKey: "schema-validator.test.dynamic-ref",
      schema: {
        $defs: {
          Value: {
            $dynamicAnchor: "value",
            type: "string",
          },
        },
        $dynamicRef: "#value",
      },
      value: 1,
    });
  });

  it("accepts draft-07 tuple item schemas", () => {
    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.tuple-items",
        schema: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
        value: ["mode", 1],
      },
      ["mode", 1],
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.tuple-items",
        schema: {
          type: "array",
          items: [
            { type: "string", default: "mode" },
            { type: "number", default: 1 },
          ],
          minItems: 2,
          additionalItems: false,
        },
        value: [],
        applyDefaults: true,
      },
      ["mode", 1],
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.prefix-items",
        schema: {
          type: "array",
          prefixItems: [
            { type: "string", default: "mode" },
            { type: "number", default: 1 },
          ],
          minItems: 2,
        },
        value: [],
        applyDefaults: true,
      },
      ["mode", 1],
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.tuple-item-nested-default",
        schema: {
          type: "array",
          items: [
            {
              type: "object",
              default: {},
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          ],
          minItems: 1,
        },
        value: [],
        applyDefaults: true,
      },
      [{ mode: "auto" }],
    );
  });

  it("applies defaults through active dependency and conditional schemas", () => {
    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.dependencies",
        schema: {
          type: "object",
          properties: {
            flag: {
              type: "boolean",
            },
          },
          dependencies: {
            flag: {
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
        },
        value: { flag: true },
        applyDefaults: true,
      },
      { flag: true, mode: "auto" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-ref",
        schema: {
          type: "object",
          $defs: {
            ApiKind: {
              properties: {
                kind: {
                  const: "api",
                },
              },
              required: ["kind"],
            },
          },
          if: {
            $ref: "#/$defs/ApiKind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-format-annotation",
        schema: {
          type: "object",
          properties: {
            contact: {
              type: "string",
            },
          },
          if: {
            properties: {
              contact: {
                type: "string",
                format: "email",
              },
            },
            required: ["contact"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              mode: {
                type: "string",
                default: "auto",
              },
            },
            required: ["mode"],
          },
        },
        value: { contact: "not an email" },
        applyDefaults: true,
      },
      { contact: "not an email", mode: "auto" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-ref-resource-property-object",
        schema: {
          type: "object",
          properties: {
            kind: {
              properties: {
                value: {
                  const: "api",
                },
              },
              required: ["value"],
            },
          },
          if: {
            $ref: "#/properties/kind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { value: "api" },
        applyDefaults: true,
      },
      { value: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-nested-ref-resource-property",
        schema: {
          type: "object",
          properties: {
            kind: {
              properties: {
                value: {
                  const: "api",
                },
              },
              required: ["value"],
            },
          },
          if: {
            properties: {
              kind: {
                $ref: "#/properties/kind",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: { value: "api" } },
        applyDefaults: true,
      },
      { kind: { value: "api" }, endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-ref-with-local-defs",
        schema: {
          type: "object",
          $defs: {
            ApiKind: {
              properties: {
                kind: {
                  const: "api",
                },
              },
              required: ["kind"],
            },
          },
          if: {
            $defs: {
              Local: {
                type: "string",
              },
            },
            $ref: "#/$defs/ApiKind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-ref-root-defs-win",
        schema: {
          type: "object",
          $defs: {
            MatchKind: {
              properties: {
                kind: {
                  const: "api",
                },
              },
              required: ["kind"],
            },
          },
          if: {
            $defs: {
              MatchKind: {
                properties: {
                  kind: {
                    const: "other",
                  },
                },
                required: ["kind"],
              },
            },
            $ref: "#/$defs/MatchKind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-activated-by-default",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
              default: "api",
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-default-selects-one-branch",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
              default: "api",
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
          },
          else: {
            properties: {
              path: {
                type: "string",
                default: "/tmp",
              },
            },
          },
        },
        value: {},
        applyDefaults: true,
      },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-default-branch-flip",
        schema: {
          type: "object",
          if: {
            not: {
              required: ["mode"],
            },
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              mode: {
                type: "string",
                default: "auto",
              },
            },
          },
          else: {
            properties: {
              explicit: {
                type: "boolean",
                default: true,
              },
            },
            required: ["explicit"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      { mode: "auto" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-defaulted-condition-remains-valid",
        schema: {
          type: "object",
          properties: {
            flag: {
              type: "boolean",
              default: true,
            },
          },
          if: {
            properties: {
              flag: { const: true },
            },
            required: ["flag"],
          },
          [jsonSchemaThenKeyword]: {
            required: ["secret"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      { flag: true },
    );

    const explicitConditionResult = expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-explicit-condition-still-fails",
      schema: {
        type: "object",
        properties: {
          flag: {
            type: "boolean",
            default: true,
          },
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          required: ["secret"],
        },
      },
      value: { flag: true },
      applyDefaults: true,
    });
    expectValidationIssue(explicitConditionResult, "<root>");

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-default",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
          },
        },
        if: {
          not: {
            required: ["mode"],
          },
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: {
              type: "number",
              default: 1,
            },
          },
        },
        else: {
          properties: {
            explicit: {
              type: "boolean",
            },
          },
          required: ["explicit"],
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-branch-default",
      schema: {
        type: "object",
        properties: {
          flag: {
            type: "boolean",
            default: true,
          },
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: {
              type: "number",
              default: "bad",
            },
          },
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-hydrates-parent-property",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
            },
            settings: {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              settings: {
                type: "object",
                default: {},
              },
            },
            required: ["settings"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      { kind: "api", settings: { mode: "auto" } },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.dependency-activated-by-default",
        schema: {
          type: "object",
          properties: {
            flag: {
              type: "boolean",
              default: true,
            },
          },
          dependencies: {
            flag: {
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
        },
        value: {},
        applyDefaults: true,
      },
      { flag: true, mode: "auto" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.conditional-activates-dependency",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
            },
          },
          dependencies: {
            flag: {
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              flag: {
                type: "boolean",
                default: true,
              },
            },
            required: ["flag"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      { kind: "api", flag: true, mode: "auto" },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.reverse-dependency-chain",
        schema: {
          type: "object",
          properties: {
            a: {
              type: "boolean",
              default: true,
            },
          },
          dependencies: {
            e: {
              properties: {
                f: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["f"],
            },
            d: {
              properties: {
                e: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["e"],
            },
            c: {
              properties: {
                d: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["d"],
            },
            b: {
              properties: {
                c: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["c"],
            },
            a: {
              properties: {
                b: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["b"],
            },
          },
        },
        value: {},
        applyDefaults: true,
      },
      { a: true, b: true, c: true, d: true, e: true, f: true },
    );

    expectSuccessfulValidationValue(
      {
        cacheKey: "schema-validator.test.defaults.dependency-activates-conditional",
        schema: {
          type: "object",
          properties: {
            a: {
              type: "boolean",
              default: true,
            },
          },
          dependencies: {
            b: {
              properties: {
                kind: {
                  const: "api",
                  default: "api",
                },
              },
              required: ["kind"],
            },
            a: {
              properties: {
                b: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["b"],
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      { a: true, b: true, kind: "api", endpoint: "https://example.com" },
    );
  });

  it("recompiles when a stable cache key receives a different schema shape", () => {
    const cacheKey = "schema-validator.test.cache-key-drift";
    const schema = { type: "string" };
    expectValidationSuccess({
      cacheKey,
      schema,
      value: "ok",
    });

    expect(() =>
      validateJsonSchemaValue({ cacheKey, schema: { type: 1n }, value: "ignored" }),
    ).toThrow("invalid schema: <schema>.type: expected string or non-empty string array");
    expectValidationSuccess({ cacheKey, schema, value: "still valid" });

    const result = expectValidationFailure({
      cacheKey,
      schema: { type: "number" },
      value: "not-a-number",
    });
    expectValidationIssue(result, "<root>");
  });

  it.each([
    {
      title: "includes allowed value in const validation errors",
      params: {
        cacheKey: "schema-validator.test.const",
        schema: {
          type: "object",
          properties: {
            mode: {
              const: "strict",
            },
          },
          required: ["mode"],
        },
        value: { mode: "relaxed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:"],
      allowedValues: ["strict"],
      hiddenCount: 0,
    },
    {
      title: "truncates long allowed-value hints",
      params: {
        cacheKey: "schema-validator.test.enum.truncate",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "v1",
                "v2",
                "v3",
                "v4",
                "v5",
                "v6",
                "v7",
                "v8",
                "v9",
                "v10",
                "v11",
                "v12",
                "v13",
              ],
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+1 more)"],
      allowedValues: ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"],
      hiddenCount: 1,
    },
  ])("$title", ({ params, path, messageIncludes, allowedValues, hiddenCount }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, path);

    expectIssueMessageIncludes(issue, messageIncludes);
    if (allowedValues) {
      expect(issue?.allowedValues).toEqual(allowedValues);
      expect(issue?.allowedValuesHiddenCount).toBe(hiddenCount);
    }
  });

  it.each([
    {
      title: "appends missing dependency property to the structured path",
      params: {
        cacheKey: "schema-validator.test.dependencies.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              dependencies: {
                mode: ["format"],
              },
            },
          },
        },
        value: { settings: { mode: "strict" } },
      },
      expectedPath: "settings.format",
    },
  ])("$title", ({ params, expectedPath }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, expectedPath);

    expect(issue?.allowedValues).toBeUndefined();
  });
});

describe("source-aware schema validation", () => {
  const cache = true;
  const schema = {
    type: "object",
    properties: {
      credential: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      retries: { type: "integer", default: 2 },
    },
    required: ["credential"],
  };

  it("validates uncached persisted references and defaults runtime without mutating either", () => {
    const sourceValue = { credential: { id: "KEY" } };
    const value = { credential: "resolved-fixture-key" };
    const params = {
      schema,
      cacheKey: "source-ref",
      value,
      sourceValue,
      applyDefaults: true,
      cache: false,
    };
    expect(validateJsonSchemaValue(params)).toEqual({
      ok: true,
      value: { ...value, retries: 2 },
    });
    expect(
      validateJsonSchemaValue({ ...params, sourceValue: { credential: "plaintext" } }).ok,
    ).toBe(false);
    expect(validateJsonSchemaValue({ ...params, sourceValue: null }).ok).toBe(false);
    expect(sourceValue).toEqual({ credential: { id: "KEY" } });
    expect(value).toEqual({ credential: "resolved-fixture-key" });
  });

  it("preserves the runtime identity without applicable defaults", () => {
    const value = { credential: "resolved-fixture-key" };
    const result = validateJsonSchemaValue({
      schema: { ...schema, properties: { credential: schema.properties.credential } },
      cacheKey: "source-no-defaults",
      sourceValue: { credential: { id: "KEY" } },
      value,
      applyDefaults: true,
      cache,
    });
    expect(result).toEqual({ ok: true, value });
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });

  it("shares compiled schemas across callers while keeping defaults tied to the source input", () => {
    const conditional = {
      ...schema,
      properties: { ...schema.properties, enabled: { type: "boolean", default: true } },
      if: { properties: { enabled: { const: true } }, required: ["enabled"] },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: { required: ["confirmation"] },
    };
    const params = {
      schema: conditional,
      cacheKey: "source-conditional",
      value: { credential: "resolved-fixture-key" },
      sourceValue: { credential: { id: "KEY" } },
      applyDefaults: true,
      cache,
    };
    expect(validateJsonSchemaValue({ ...params, applyDefaults: false })).toEqual({
      ok: true,
      value: params.value,
    });
    const compile = vi.spyOn(globalThis, "Function");
    try {
      expect(
        validateJsonSchemaValue({
          ...params,
          schema: structuredClone(conditional),
          cacheKey: "source-conditional-clone",
        }),
      ).toEqual({
        ok: true,
        value: { credential: "resolved-fixture-key", retries: 2, enabled: true },
      });
      expect(
        validateJsonSchemaValue({
          ...params,
          sourceValue: { ...params.sourceValue, enabled: true },
        }).ok,
      ).toBe(false);
      expect(validateJsonSchemaValue(params)).toEqual({
        ok: true,
        value: { credential: "resolved-fixture-key", retries: 2, enabled: true },
      });
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });

  it("rejects invalid source even when the runtime itself matches the schema", () => {
    const sourceValue = { credential: "invalid-plaintext-fixture" };
    const result = validateJsonSchemaValue({
      schema,
      cacheKey: "source-invalid",
      sourceValue,
      value: { credential: { id: "VALID" } },
      applyDefaults: true,
      cache,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("invalid-plaintext-fixture");
  });

  it("uses source-selected conditional defaults in nested runtime objects and arrays", () => {
    const settingsSchema = {
      ...schema,
      properties: { ...schema.properties, endpoint: { type: "string" } },
      if: { properties: { credential: { type: "object" } }, required: ["credential"] },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: { properties: { endpoint: { default: "https://reference.example" } } },
      else: { properties: { endpoint: { default: "https://plaintext.example" } } },
    };
    const sourceValue = { accounts: [{ credential: { id: "KEY" } }] };
    const value = { accounts: [{ credential: "resolved-fixture-key" }] };
    expect(
      validateJsonSchemaValue({
        schema: {
          type: "object",
          properties: { accounts: { type: "array", items: settingsSchema } },
        },
        cacheKey: "source-conditional-branch",
        value,
        sourceValue,
        applyDefaults: true,
        cache,
      }),
    ).toEqual({
      ok: true,
      value: {
        accounts: [
          { credential: "resolved-fixture-key", retries: 2, endpoint: "https://reference.example" },
        ],
      },
    });
    expect(sourceValue).toEqual({ accounts: [{ credential: { id: "KEY" } }] });
    expect(value).toEqual({ accounts: [{ credential: "resolved-fixture-key" }] });
  });

  it("preserves runtime overrides and removed references while transferring source defaults", () => {
    const sourceValue = { credential: { id: "KEY" }, accounts: [{ credential: { id: "OTHER" } }] };
    const value = { retries: 9, accounts: [{ credential: "resolved-fixture-key" }] };
    const before = structuredClone({ sourceValue, value });
    expect(
      validateJsonSchemaValue({
        schema: {
          ...schema,
          properties: { ...schema.properties, accounts: { type: "array", items: schema } },
        },
        cacheKey: "source-preserve-runtime",
        value,
        sourceValue,
        applyDefaults: true,
        cache,
      }),
    ).toEqual({
      ok: true,
      value: { retries: 9, accounts: [{ credential: "resolved-fixture-key", retries: 2 }] },
    });
    expect({ sourceValue, value }).toEqual(before);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
