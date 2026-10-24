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

const fields = (properties: Record<string, unknown>, required?: string[]) => ({
  properties,
  ...(required ? { required } : {}),
});
const objectSchema = (properties: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  ...rest,
});
const conditionalSchema = (
  condition: object,
  branch: object,
  rest: Record<string, unknown> = {},
) => ({
  type: "object",
  ...rest,
  if: condition,
  [jsonSchemaThenKeyword]: branch,
});
const defaulted = (type: string, value: unknown) => ({ type, default: value });
const apiCondition = () => fields({ kind: { const: "api" } }, ["kind"]);
const modeDefaults = () => fields({ mode: defaulted("string", "auto") }, ["mode"]);
const requiredFlagDefault = (name: string) =>
  fields({ [name]: defaulted("boolean", true) }, [name]);
function endpointDefaults(required = false) {
  const properties = { endpoint: defaulted("string", "https://example.com") };
  return required ? fields(properties, ["endpoint"]) : fields(properties);
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
  expect(validateJsonSchemaValue(input)).toEqual({ ok: true, value: expectedValue });
}

function expectDefaults(
  schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"],
  value: unknown,
  expectedValue: unknown,
) {
  expectSuccessfulValidationValue({ schema, value, applyDefaults: true }, expectedValue);
}

function expectReference(schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"]) {
  expectSuccessfulValidationValue({ schema, value: "ok" }, "ok");
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
      ["required", objectSchema({ url: { type: "string" } }, { required: "url" })],
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
        { anyOf: [{ type: "number" }, { type: "string" }], $ref: "#/anyOf/01" },
      ],
      ["dynamic-ref-type", { $dynamicRef: 123 }],
      ["dynamic-ref", { $dynamicRef: "#/$defs/Missing" }],
      ["nullable-type", { type: "string", nullable: "yes" }],
      ["nullable-without-type", { nullable: true }],
      [
        "anchor-ref",
        { $defs: { Other: { $id: "other", $anchor: "value", type: "string" } }, $ref: "#value" },
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
      schema: { $defs: { Never: false }, $ref: "#/$defs/Never" },
      value: "anything",
    });
    expectValidationIssue(denied, "<root>");

    expectReference({
      $defs: { Value: { $anchor: "value", type: "string" } },
      $ref: "#value",
    });

    expectReference({
      $defs: {
        Other: {
          $id: "other",
          $defs: { Value: { $anchor: "value", type: "string" } },
          $ref: "#value",
        },
      },
      $ref: "#/$defs/Other",
    });

    expectReference({
      $id: "https://example.com/schema",
      $defs: { Value: { type: "string" } },
      $ref: "https://example.com/schema#/$defs/Value",
    });

    expectReference({
      $defs: { Value: { $id: "https://example.com/value", type: "string" } },
      $ref: "https://example.com/value",
    });

    expectReference({
      $defs: { Value: { $id: "value", type: "string" } },
      $ref: "value",
    });

    expectReference({
      $id: "https://example.com/root/",
      $defs: { Value: { $id: "value", type: "string" } },
      $ref: "https://example.com/root/value",
    });

    expectReference({
      $id: "",
      $defs: { Value: { type: "string" } },
      $ref: "#/$defs/Value",
    });

    expectReference({
      $defs: { Value: { $dynamicAnchor: "value", type: "string" } },
      $dynamicRef: "#value",
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.dynamic-ref",
      schema: {
        $defs: { Value: { $dynamicAnchor: "value", type: "string" } },
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
      {
        type: "array",
        prefixItems: [defaulted("string", "mode"), defaulted("number", 1)],
        minItems: 2,
      },
      [],
      ["mode", 1],
    );

    expectDefaults(
      {
        type: "array",
        items: [
          objectSchema({ mode: defaulted("string", "auto") }, { default: {}, required: ["mode"] }),
        ],
        minItems: 1,
      },
      [],
      [{ mode: "auto" }],
    );
  });

  it("applies defaults through active dependency and conditional schemas", () => {
    expectDefaults(
      objectSchema({ flag: { type: "boolean" } }, { dependencies: { flag: modeDefaults() } }),
      { flag: true },
      { flag: true, mode: "auto" },
    );

    expectDefaults(
      conditionalSchema(apiCondition(), endpointDefaults(true), {
        properties: { kind: { const: "api" } },
      }),
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema({ $ref: "#/$defs/ApiKind" }, endpointDefaults(true), {
        $defs: { ApiKind: apiCondition() },
      }),
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(
        fields({ contact: { type: "string", format: "email" } }, ["contact"]),
        modeDefaults(),
        { properties: { contact: { type: "string" } } },
      ),
      { contact: "not an email" },
      { contact: "not an email", mode: "auto" },
    );

    expectDefaults(
      conditionalSchema({ $ref: "#/properties/kind" }, endpointDefaults(true), {
        properties: { kind: fields({ value: { const: "api" } }, ["value"]) },
      }),
      { value: "api" },
      { value: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(
        fields({ kind: { $ref: "#/properties/kind" } }, ["kind"]),
        endpointDefaults(true),
        { properties: { kind: fields({ value: { const: "api" } }, ["value"]) } },
      ),
      { kind: { value: "api" } },
      { kind: { value: "api" }, endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(
        { $defs: { Local: { type: "string" } }, $ref: "#/$defs/ApiKind" },
        endpointDefaults(true),
        { $defs: { ApiKind: apiCondition() } },
      ),
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(
        {
          $defs: { MatchKind: fields({ kind: { const: "other" } }, ["kind"]) },
          $ref: "#/$defs/MatchKind",
        },
        endpointDefaults(),
        { $defs: { MatchKind: apiCondition() } },
      ),
      { kind: "api" },
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(apiCondition(), endpointDefaults(true), {
        properties: { kind: { const: "api", default: "api" } },
      }),
      {},
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(apiCondition(), endpointDefaults(), {
        properties: { kind: { const: "api", default: "api" } },
        else: fields({ path: defaulted("string", "/tmp") }),
      }),
      {},
      { kind: "api", endpoint: "https://example.com" },
    );

    expectDefaults(
      conditionalSchema(
        { not: { required: ["mode"] } },
        fields({ mode: defaulted("string", "auto") }),
        {
          else: fields({ explicit: defaulted("boolean", true) }, ["explicit"]),
        },
      ),
      {},
      { mode: "auto" },
    );

    expectDefaults(
      conditionalSchema(
        fields({ flag: { const: true } }, ["flag"]),
        { required: ["secret"] },
        { properties: { flag: defaulted("boolean", true) } },
      ),
      {},
      { flag: true },
    );

    const explicitConditionResult = expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-explicit-condition-still-fails",
      schema: conditionalSchema(
        fields({ flag: { const: true } }, ["flag"]),
        { required: ["secret"] },
        { properties: { flag: defaulted("boolean", true) } },
      ),
      value: { flag: true },
      applyDefaults: true,
    });
    expectValidationIssue(explicitConditionResult, "<root>");

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-default",
      schema: conditionalSchema(
        { not: { required: ["mode"] } },
        fields({ mode: defaulted("number", 1) }),
        {
          properties: { mode: { type: "string" } },
          else: fields({ explicit: { type: "boolean" } }, ["explicit"]),
        },
      ),
      value: {},
      applyDefaults: true,
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-branch-default",
      schema: conditionalSchema(
        fields({ flag: { const: true } }, ["flag"]),
        fields({ mode: defaulted("number", "bad") }),
        { properties: { flag: defaulted("boolean", true) } },
      ),
      value: {},
      applyDefaults: true,
    });

    expectDefaults(
      conditionalSchema(
        apiCondition(),
        fields({ settings: { type: "object", default: {} } }, ["settings"]),
        {
          properties: {
            kind: { const: "api" },
            settings: objectSchema({ mode: defaulted("string", "auto") }, { required: ["mode"] }),
          },
        },
      ),
      { kind: "api" },
      { kind: "api", settings: { mode: "auto" } },
    );

    expectDefaults(
      objectSchema(
        { flag: defaulted("boolean", true) },
        { dependencies: { flag: modeDefaults() } },
      ),
      {},
      { flag: true, mode: "auto" },
    );

    expectDefaults(
      conditionalSchema(apiCondition(), requiredFlagDefault("flag"), {
        properties: { kind: { const: "api" } },
        dependencies: { flag: modeDefaults() },
      }),
      { kind: "api" },
      { kind: "api", flag: true, mode: "auto" },
    );

    expectDefaults(
      objectSchema(
        { a: defaulted("boolean", true) },
        {
          dependencies: {
            e: requiredFlagDefault("f"),
            d: requiredFlagDefault("e"),
            c: requiredFlagDefault("d"),
            b: requiredFlagDefault("c"),
            a: requiredFlagDefault("b"),
          },
        },
      ),
      {},
      { a: true, b: true, c: true, d: true, e: true, f: true },
    );

    expectDefaults(
      conditionalSchema(apiCondition(), endpointDefaults(true), {
        properties: { a: defaulted("boolean", true) },
        dependencies: {
          b: fields({ kind: { const: "api", default: "api" } }, ["kind"]),
          a: requiredFlagDefault("b"),
        },
      }),
      {},
      { a: true, b: true, kind: "api", endpoint: "https://example.com" },
    );
  });

  it("recompiles when a stable cache key receives a different schema shape", () => {
    const cacheKey = "schema-validator.test.cache-key-drift";
    const schema = { type: "string" };
    expectValidationSuccess({ cacheKey, schema, value: "ok" });

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
        schema: objectSchema({ mode: { const: "strict" } }, { required: ["mode"] }),
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
        schema: objectSchema(
          {
            mode: {
              type: "string",
              enum: Array.from({ length: 13 }, (_, index) => `v${index + 1}`),
            },
          },
          { required: ["mode"] },
        ),
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
        schema: objectSchema({ settings: { type: "object", dependencies: { mode: ["format"] } } }),
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
  const schema = objectSchema(
    {
      credential: objectSchema({ id: { type: "string" } }, { required: ["id"] }),
      retries: { type: "integer", default: 2 },
    },
    { required: ["credential"] },
  );

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
    expect(validateJsonSchemaValue(params)).toEqual({ ok: true, value: { ...value, retries: 2 } });
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
      if: fields({ enabled: { const: true } }, ["enabled"]),
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
      if: fields({ credential: { type: "object" } }, ["credential"]),
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: fields({ endpoint: { default: "https://reference.example" } }),
      else: fields({ endpoint: { default: "https://plaintext.example" } }),
    };
    const sourceValue = { accounts: [{ credential: { id: "KEY" } }] };
    const value = { accounts: [{ credential: "resolved-fixture-key" }] };
    expect(
      validateJsonSchemaValue({
        schema: objectSchema({ accounts: { type: "array", items: settingsSchema } }),
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

function diagnostic(
  path: string,
  valuePath: string[],
  message: string,
  text = `${path}: ${message}`,
) {
  return { path, valuePath, message, text };
}

function requiredDiagnostic(path: string, valuePath: string[], name: string) {
  return diagnostic(path, valuePath, `must have required property '${name}'`);
}

function dependency(path: string, valuePath: string[], trigger: string, names = "left, right") {
  return diagnostic(
    path,
    valuePath,
    `must have properties ${names} when property ${trigger} is present`,
  );
}

function requiredSchema(names: string[], container?: string) {
  const schema = { type: "object", required: names };
  return container ? { type: "object", properties: { [container]: schema } } : schema;
}

describe("required and dependency diagnostics", () => {
  it("preserves exact value paths despite ambiguous display paths", () => {
    const result = expectValidationFailure({
      schema: {
        type: "object",
        properties: {
          "dot.name": { type: "number" },
          dot: { type: "object", properties: { name: { type: "number" } } },
          "slash/name": { type: "number" },
          "tilde~1name": { type: "number" },
          "": { type: "number" },
          "<root>": { type: "number" },
          items: { type: "array", items: { type: "number" } },
        },
      },
      value: {
        "dot.name": "invalid",
        dot: { name: "invalid" },
        "slash/name": "invalid",
        "tilde~1name": "invalid",
        "": "invalid",
        "<root>": "invalid",
        items: ["invalid"],
      },
    });

    expect(result.errors.map(({ valuePath }) => valuePath)).toEqual([
      ["dot.name"],
      ["dot", "name"],
      ["slash/name"],
      ["tilde~1name"],
      [""],
      ["<root>"],
      ["items", "0"],
    ]);
    expect(
      expectValidationFailure({ schema: { type: "number" }, value: "invalid" }).errors,
    ).toMatchObject([{ path: "<root>", valuePath: [] }]);
  });

  it.each([
    {
      title: "multiple nested fields",
      schema: requiredSchema(["endpoint", "token"], "settings"),
      value: { settings: {} },
      expectedErrors: [
        requiredDiagnostic("settings.endpoint", ["settings", "endpoint"], "endpoint"),
        requiredDiagnostic("settings.token", ["settings", "token"], "token"),
      ],
    },
    {
      title: "terminal controls in a later field",
      schema: requiredSchema(["endpoint", "evil\nkey\t\x1b[31mred\x1b[0m"]),
      value: {},
      expectedErrors: [
        requiredDiagnostic("endpoint", ["endpoint"], "endpoint"),
        diagnostic(
          "evil\nkey\t\x1b[31mred\x1b[0m",
          ["evil\nkey\t\x1b[31mred\x1b[0m"],
          "must have required property 'evil\nkey\t\x1b[31mred\x1b[0m'",
          "evil\\nkey\\tred: must have required property 'evil\\nkey\\tred'",
        ),
      ],
    },
    {
      title: "literal missing property names",
      schema: requiredSchema(["dot.name", "slash/name", "tilde~1name", "", "<root>"], "settings"),
      value: { settings: {} },
      expectedErrors: [
        requiredDiagnostic("settings.dot.name", ["settings", "dot.name"], "dot.name"),
        requiredDiagnostic("settings.slash/name", ["settings", "slash/name"], "slash/name"),
        requiredDiagnostic("settings.tilde~1name", ["settings", "tilde~1name"], "tilde~1name"),
        requiredDiagnostic("settings", ["settings", ""], ""),
        requiredDiagnostic("settings.<root>", ["settings", "<root>"], "<root>"),
      ],
    },
  ])("reports complete required diagnostics for $title", ({ schema, value, expectedErrors }) => {
    const result = expectValidationFailure({
      schema,
      value,
    });

    expect(result.errors).toEqual(expectedErrors);
  });

  it.each([
    {
      title: "all dependencies missing in one condition",
      schema: { type: "object", dependentRequired: { a: ["b", "c"] } },
      value: { a: true },
      expectedErrors: [dependency("<root>", [], "a", "b, c")],
    },
    {
      title: "root with the first dependency already present",
      schema: { type: "object", dependencies: { a: ["b", "c"] } },
      value: { a: true, b: "present" },
      expectedErrors: [dependency("<root>", [], "a", "b, c")],
    },
    {
      title: "literal and nested containers with distinct conditions",
      schema: {
        type: "object",
        properties: {
          "room/one": { type: "object", dependentRequired: { literal: ["left", "right"] } },
          room: {
            type: "object",
            properties: {
              one: { type: "object", dependentRequired: { nested: ["left", "right"] } },
            },
          },
          "room~1one": { type: "object", dependentRequired: { tilde: ["left", "right"] } },
          "room%2Fone": { type: "object", dependentRequired: { percent: ["left", "right"] } },
        },
      },
      value: {
        "room/one": { literal: true, left: "present" },
        room: { one: { nested: true, right: "present" } },
        "room~1one": { tilde: true, left: "present" },
        "room%2Fone": { percent: true, right: "present" },
      },
      expectedErrors: [
        dependency("room.one", ["room/one"], "literal"),
        dependency("room.one", ["room", "one"], "nested"),
        dependency("room~1one", ["room~1one"], "tilde"),
        dependency("room%2Fone", ["room%2Fone"], "percent"),
      ],
    },
  ])("preserves the dependency condition at $title", ({ schema, value, expectedErrors }) => {
    const result = expectValidationFailure({
      schema,
      value,
    });

    expect(result.errors).toEqual(expectedErrors);
  });
});
