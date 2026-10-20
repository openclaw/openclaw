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

const defaulted = (type: string, value: unknown) => ({ type, default: value });
const apiCondition = () => ({ properties: { kind: { const: "api" } }, required: ["kind"] });
const modeDefaults = () => ({
  properties: { mode: defaulted("string", "auto") },
  required: ["mode"],
});
const requiredFlagDefault = (name: string) => ({
  properties: { [name]: defaulted("boolean", true) },
  required: [name],
});
function endpointDefaults(required = false) {
  const properties = { endpoint: defaulted("string", "https://example.com") };
  return required ? { properties, required: ["endpoint"] } : { properties };
}

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

function expectDefaults(
  cacheKey: string,
  schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"],
  value: unknown,
  expectedValue: unknown,
) {
  expectSuccessfulValidationValue({ cacheKey, schema, value, applyDefaults: true }, expectedValue);
}

function expectReference(
  cacheKey: string,
  schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"],
) {
  expectSuccessfulValidationValue({ cacheKey, schema, value: "ok" }, "ok");
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
      ["required", { type: "object", properties: { url: { type: "string" } }, required: "url" }],
      ["min-length", { type: "string", minLength: "1" }],
      ["additional-properties", { type: "object", additionalProperties: [] }],
      ["empty-allof", { allOf: [] }],
      ["empty-anyof", { anyOf: [] }],
      ["empty-oneof", { oneOf: [] }],
      ["empty-enum", { enum: [] }],
      ["duplicate-enum", { enum: ["api", "api"] }],
      ["duplicate-required", { type: "object", required: ["mode", "mode"] }],
      ["duplicate-type-array", { type: ["string", "string"] }],
      ["ref", { $ref: "#/$defs/Missing" }],
      [
        "array-ref-leading-zero",
        {
          anyOf: [{ type: "number" }, { type: "string" }],
          $ref: "#/anyOf/01",
        },
      ],
      ["dynamic-ref-type", { $dynamicRef: 123 }],
      ["dynamic-ref", { $dynamicRef: "#/$defs/Missing" }],
      ["nullable-type", { type: "string", nullable: "yes" }],
      ["nullable-without-type", { nullable: true }],
      [
        "anchor-ref",
        {
          $defs: {
            Other: { $id: "other", $anchor: "value", type: "string" },
          },
          $ref: "#value",
        },
      ],
      ["external-ref", { $ref: "https://example.com/missing" }],
      ["dependencies-value", { type: "object", dependencies: { mode: 123 } }],
      ["dependencies-array", { type: "object", dependencies: { mode: [1] } }],
    ] as const) {
      expect(() =>
        validateJsonSchemaValue({
          cacheKey: `schema-validator.test.invalid-${cacheKey}`,
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

    expectReference("schema-validator.test.anchor-ref", {
      $defs: {
        Value: {
          $anchor: "value",
          type: "string",
        },
      },
      $ref: "#value",
    });

    expectReference("schema-validator.test.nested-resource-anchor-ref", {
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
    });

    expectReference("schema-validator.test.absolute-same-document-ref", {
      $id: "https://example.com/schema",
      $defs: {
        Value: { type: "string" },
      },
      $ref: "https://example.com/schema#/$defs/Value",
    });

    expectReference("schema-validator.test.embedded-absolute-id-ref", {
      $defs: {
        Value: {
          $id: "https://example.com/value",
          type: "string",
        },
      },
      $ref: "https://example.com/value",
    });

    expectReference("schema-validator.test.embedded-relative-id-ref", {
      $defs: {
        Value: {
          $id: "value",
          type: "string",
        },
      },
      $ref: "value",
    });

    expectReference("schema-validator.test.resolved-relative-id-ref", {
      $id: "https://example.com/root/",
      $defs: {
        Value: {
          $id: "value",
          type: "string",
        },
      },
      $ref: "https://example.com/root/value",
    });

    expectReference("schema-validator.test.empty-id-local-ref", {
      $id: "",
      $defs: {
        Value: { type: "string" },
      },
      $ref: "#/$defs/Value",
    });

    expectReference("schema-validator.test.dynamic-ref", {
      $defs: {
        Value: {
          $dynamicAnchor: "value",
          type: "string",
        },
      },
      $dynamicRef: "#value",
    });

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

    expectDefaults(
      "schema-validator.test.defaults.tuple-items",
      {
        type: "array",
        items: [defaulted("string", "mode"), defaulted("number", 1)],
        minItems: 2,
        additionalItems: false,
      },
      [],
      ["mode", 1],
    );

    expectDefaults(
      "schema-validator.test.defaults.prefix-items",
      {
        type: "array",
        prefixItems: [defaulted("string", "mode"), defaulted("number", 1)],
        minItems: 2,
      },
      [],
      ["mode", 1],
    );

    expectDefaults(
      "schema-validator.test.defaults.tuple-item-nested-default",
      {
        type: "array",
        items: [
          {
            type: "object",
            default: {},
            properties: {
              mode: defaulted("string", "auto"),
            },
            required: ["mode"],
          },
        ],
        minItems: 1,
      },
      [],
      [{ mode: "auto" }],
    );
  });

  it("applies defaults through active dependency and conditional schemas", () => {
    expectDefaults(
      "schema-validator.test.defaults.dependencies",
      {
        type: "object",
        properties: {
          flag: { type: "boolean" },
        },
        dependencies: {
          flag: modeDefaults(),
        },
      },
      { flag: true },
      { flag: true, mode: "auto" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional",
      {
        type: "object",
        properties: {
          kind: { const: "api" },
        },
        if: apiCondition(),
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-ref",
      {
        type: "object",
        $defs: {
          ApiKind: apiCondition(),
        },
        if: { $ref: "#/$defs/ApiKind" },
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-format-annotation",
      {
        type: "object",
        properties: {
          contact: { type: "string" },
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
        [jsonSchemaThenKeyword]: modeDefaults(),
      },
      { contact: "not an email" },
      { contact: "not an email", mode: "auto" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-ref-resource-property-object",
      {
        type: "object",
        properties: {
          kind: {
            properties: {
              value: { const: "api" },
            },
            required: ["value"],
          },
        },
        if: { $ref: "#/properties/kind" },
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      { value: "api" },
      { value: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-nested-ref-resource-property",
      {
        type: "object",
        properties: {
          kind: {
            properties: {
              value: { const: "api" },
            },
            required: ["value"],
          },
        },
        if: {
          properties: {
            kind: { $ref: "#/properties/kind" },
          },
          required: ["kind"],
        },
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      { kind: { value: "api" } },
      { kind: { value: "api" }, endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-ref-with-local-defs",
      {
        type: "object",
        $defs: {
          ApiKind: apiCondition(),
        },
        if: {
          $defs: {
            Local: { type: "string" },
          },
          $ref: "#/$defs/ApiKind",
        },
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-ref-root-defs-win",
      {
        type: "object",
        $defs: {
          MatchKind: apiCondition(),
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
        [jsonSchemaThenKeyword]: endpointDefaults(),
      },
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-activated-by-default",
      {
        type: "object",
        properties: {
          kind: { const: "api", default: "api" },
        },
        if: apiCondition(),
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      {},
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-default-selects-one-branch",
      {
        type: "object",
        properties: {
          kind: { const: "api", default: "api" },
        },
        if: apiCondition(),
        [jsonSchemaThenKeyword]: endpointDefaults(),
        else: {
          properties: {
            path: defaulted("string", "/tmp"),
          },
        },
      },
      {},
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-default-branch-flip",
      {
        type: "object",
        if: {
          not: {
            required: ["mode"],
          },
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: defaulted("string", "auto"),
          },
        },
        else: {
          properties: {
            explicit: defaulted("boolean", true),
          },
          required: ["explicit"],
        },
      },
      {},
      { mode: "auto" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-defaulted-condition-remains-valid",
      {
        type: "object",
        properties: {
          flag: defaulted("boolean", true),
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
      {},
      { flag: true },
    );

    const explicitConditionResult = expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-explicit-condition-still-fails",
      schema: {
        type: "object",
        properties: {
          flag: defaulted("boolean", true),
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
          mode: { type: "string" },
        },
        if: {
          not: {
            required: ["mode"],
          },
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: defaulted("number", 1),
          },
        },
        else: {
          properties: {
            explicit: { type: "boolean" },
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
          flag: defaulted("boolean", true),
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: defaulted("number", "bad"),
          },
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectDefaults(
      "schema-validator.test.defaults.conditional-hydrates-parent-property",
      {
        type: "object",
        properties: {
          kind: { const: "api" },
          settings: {
            type: "object",
            properties: {
              mode: defaulted("string", "auto"),
            },
            required: ["mode"],
          },
        },
        if: apiCondition(),
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
      { kind: "api" },
      { kind: "api", settings: { mode: "auto" } },
    );

    expectDefaults(
      "schema-validator.test.defaults.dependency-activated-by-default",
      {
        type: "object",
        properties: {
          flag: defaulted("boolean", true),
        },
        dependencies: {
          flag: modeDefaults(),
        },
      },
      {},
      { flag: true, mode: "auto" },
    );

    expectDefaults(
      "schema-validator.test.defaults.conditional-activates-dependency",
      {
        type: "object",
        properties: {
          kind: { const: "api" },
        },
        dependencies: {
          flag: modeDefaults(),
        },
        if: apiCondition(),
        [jsonSchemaThenKeyword]: requiredFlagDefault("flag"),
      },
      { kind: "api" },
      { kind: "api", flag: true, mode: "auto" },
    );

    expectDefaults(
      "schema-validator.test.defaults.reverse-dependency-chain",
      {
        type: "object",
        properties: {
          a: defaulted("boolean", true),
        },
        dependencies: {
          e: requiredFlagDefault("f"),
          d: requiredFlagDefault("e"),
          c: requiredFlagDefault("d"),
          b: requiredFlagDefault("c"),
          a: requiredFlagDefault("b"),
        },
      },
      {},
      { a: true, b: true, c: true, d: true, e: true, f: true },
    );

    expectDefaults(
      "schema-validator.test.defaults.dependency-activates-conditional",
      {
        type: "object",
        properties: {
          a: defaulted("boolean", true),
        },
        dependencies: {
          b: {
            properties: {
              kind: { const: "api", default: "api" },
            },
            required: ["kind"],
          },
          a: requiredFlagDefault("b"),
        },
        if: apiCondition(),
        [jsonSchemaThenKeyword]: endpointDefaults(true),
      },
      {},
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
              enum: Array.from({ length: 13 }, (_, index) => `v${index + 1}`),
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
      properties: { ...schema.properties, enabled: defaulted("boolean", true) },
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
