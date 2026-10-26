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

describe("schema validator", () => {
  it.each([
    ["<root>", []],
    ["items.0.enabled", ["items", 0, "enabled"]],
    ["items.100001.enabled", ["items", "100001", "enabled"]],
  ])("parses JSON Schema issue path %s", (path, expected) => {
    expect(parseJsonSchemaIssuePath(path)).toEqual(expected);
  });

  it("rejects invalid JSON Schema constraint keyword values", () => {
    for (const schema of [
      objectSchema({ url: { type: "string" } }, { required: "url" }),
      { type: "string", minLength: "1" },
      { type: "object", additionalProperties: [] },
      { allOf: [] },
      { anyOf: [] },
      { oneOf: [] },
      { enum: [] },
      { enum: ["api", "api"] },
      { type: "object", required: ["mode", "mode"] },
      { type: ["string", "string"] },
      { $ref: "#/$defs/Missing" },
      { anyOf: [{ type: "number" }, { type: "string" }], $ref: "#/anyOf/01" },
      { $dynamicRef: 123 },
      { $dynamicRef: "#/$defs/Missing" },
      { type: "string", nullable: "yes" },
      { nullable: true },
      { $defs: { Other: { $id: "other", $anchor: "value", type: "string" } }, $ref: "#value" },
      { $ref: "https://example.com/missing" },
      { type: "object", dependencies: { mode: 123 } },
      { type: "object", dependencies: { mode: [1] } },
    ] as const) {
      expect(() => validateJsonSchemaValue({ schema, value: "anything" })).toThrow(
        "invalid schema",
      );
    }
  });

  it("accepts valid local refs to boolean schemas and anchors", () => {
    const denied = expectValidationFailure({
      cacheKey: "schema-validator.test.false-ref",
      schema: { $defs: { Never: false }, $ref: "#/$defs/Never" },
      value: "anything",
    });
    expectValidationIssue(denied, "<root>");

    const string = { type: "string" };
    const anchored = { $defs: { Value: { ...string, $anchor: "value" } }, $ref: "#value" };
    for (const schema of [
      anchored,
      { $defs: { Other: { $id: "other", ...anchored } }, $ref: "#/$defs/Other" },
      {
        $id: "https://example.com/schema",
        $defs: { Value: string },
        $ref: "https://example.com/schema#/$defs/Value",
      },
      {
        $defs: { Value: { ...string, $id: "https://example.com/value" } },
        $ref: "https://example.com/value",
      },
      { $defs: { Value: { ...string, $id: "value" } }, $ref: "value" },
      {
        $id: "https://example.com/root/",
        $defs: { Value: { ...string, $id: "value" } },
        $ref: "https://example.com/root/value",
      },
      { $id: "", $defs: { Value: string }, $ref: "#/$defs/Value" },
      { $defs: { Value: { ...string, $dynamicAnchor: "value" } }, $dynamicRef: "#value" },
    ]) {
      expectReference(schema);
    }

    expectValidationFailure({
      cacheKey: "schema-validator.test.dynamic-ref",
      schema: {
        $defs: { Value: { $dynamicAnchor: "value", type: "string" } },
        $dynamicRef: "#value",
      },
      value: 1,
    });
  });

  it("accepts draft-07 tuples and applies defaults to legacy and prefix items", () => {
    const pair = [defaulted("string", "mode"), defaulted("number", 1)];
    const tuple = { type: "array", items: pair, additionalItems: false };
    expectSuccessfulValidationValue({ schema: tuple, value: ["mode", 1] }, ["mode", 1]);
    for (const items of [{ items: pair, additionalItems: false }, { prefixItems: pair }]) {
      expectDefaults({ type: "array", minItems: 2, ...items }, [], ["mode", 1]);
    }
    expectDefaults(
      {
        type: "array",
        minItems: 1,
        items: [
          objectSchema({ mode: defaulted("string", "auto") }, { default: {}, required: ["mode"] }),
        ],
      },
      [],
      [{ mode: "auto" }],
    );
  });

  it("applies defaults through active dependency and conditional schemas", () => {
    const kind = { kind: { const: "api" } };
    const defaultKind = { kind: { const: "api", default: "api" } };
    const kindReference = fields({ value: { const: "api" } }, ["value"]);
    const withEndpoint = (schema: Parameters<typeof expectDefaults>[0], value = { kind: "api" }) =>
      expectDefaults(schema, value, { ...value, endpoint: "https://example.com" });
    const flagConditional = conditionalSchema(
      fields({ flag: { const: true } }, ["flag"]),
      { required: ["secret"] },
      { properties: { flag: defaulted("boolean", true) } },
    );
    const modeConditional = conditionalSchema(
      { not: { required: ["mode"] } },
      fields({ mode: defaulted("string", "auto") }),
      { else: fields({ explicit: defaulted("boolean", true) }, ["explicit"]) },
    );

    expectDefaults(
      objectSchema({ flag: { type: "boolean" } }, { dependencies: { flag: modeDefaults() } }),
      { flag: true },
      { flag: true, mode: "auto" },
    );
    for (const schema of [
      conditionalSchema({ $ref: "#/$defs/ApiKind" }, endpointDefaults(true), {
        $defs: { ApiKind: apiCondition() },
      }),
      conditionalSchema(
        {
          $defs: { MatchKind: fields({ kind: { const: "other" } }, ["kind"]) },
          $ref: "#/$defs/MatchKind",
        },
        endpointDefaults(),
        { $defs: { MatchKind: apiCondition() } },
      ),
    ]) {
      withEndpoint(schema);
    }
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
      conditionalSchema(
        fields({ kind: { $ref: "#/properties/kind" } }, ["kind"]),
        endpointDefaults(true),
        { properties: { kind: kindReference } },
      ),
      { kind: { value: "api" } },
      { kind: { value: "api" }, endpoint: "https://example.com" },
    );
    expectDefaults(
      conditionalSchema(apiCondition(), endpointDefaults(), {
        properties: defaultKind,
        else: fields({ path: defaulted("string", "/tmp") }),
      }),
      {},
      { kind: "api", endpoint: "https://example.com" },
    );
    expectDefaults(modeConditional, {}, { mode: "auto" });
    expectDefaults(flagConditional, {}, { flag: true });
    expectValidationIssue(
      expectValidationFailure({
        schema: flagConditional,
        value: { flag: true },
        applyDefaults: true,
      }),
      "<root>",
    );
    for (const schema of [
      conditionalSchema({ not: { required: ["mode"] } }, fields({ mode: defaulted("number", 1) }), {
        properties: { mode: { type: "string" } },
        else: fields({ explicit: { type: "boolean" } }, ["explicit"]),
      }),
      conditionalSchema(
        fields({ flag: { const: true } }, ["flag"]),
        fields({ mode: defaulted("number", "bad") }),
        { properties: { flag: defaulted("boolean", true) } },
      ),
    ]) {
      expectValidationFailure({ schema, value: {}, applyDefaults: true });
    }
    expectDefaults(
      conditionalSchema(
        apiCondition(),
        fields({ settings: { type: "object", default: {} } }, ["settings"]),
        {
          properties: {
            ...kind,
            settings: objectSchema({ mode: defaulted("string", "auto") }, { required: ["mode"] }),
          },
        },
      ),
      { kind: "api" },
      { kind: "api", settings: { mode: "auto" } },
    );
    expectDefaults(
      conditionalSchema(apiCondition(), requiredFlagDefault("flag"), {
        properties: kind,
        dependencies: { flag: modeDefaults() },
      }),
      { kind: "api" },
      { kind: "api", flag: true, mode: "auto" },
    );
    expectDefaults(
      conditionalSchema(apiCondition(), endpointDefaults(true), {
        properties: { a: defaulted("boolean", true) },
        dependencies: { b: fields(defaultKind, ["kind"]), a: requiredFlagDefault("b") },
      }),
      {},
      { a: true, b: true, kind: "api", endpoint: "https://example.com" },
    );
  });

  it("reports malformed schemas that cannot be serialized for cache lookup", () => {
    expect(() => validateJsonSchemaValue({ schema: { type: 1n }, value: "ignored" })).toThrow(
      "invalid schema: <schema>.type: expected string or non-empty string array",
    );
  });

  it.each([
    [{ const: "strict" }, ["strict"], 0],
    [
      { type: "string", enum: Array.from({ length: 13 }, (_, i) => `v${i + 1}`) },
      ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"],
      1,
    ],
  ] as const)("includes bounded allowed values for %j", (property, allowedValues, hiddenCount) => {
    const issue = expectValidationIssue(
      expectValidationFailure({
        schema: objectSchema({ mode: property }, { required: ["mode"] }),
        value: { mode: "not-listed" },
      }),
      "mode",
    );
    expect(issue.message).toContain("(allowed:");
    if (hiddenCount) {
      expect(issue.message).toContain("... (+1 more)");
    }
    expect([issue.allowedValues, issue.allowedValuesHiddenCount]).toEqual([
      allowedValues,
      hiddenCount,
    ]);
  });

  it("appends missing dependency property to the structured path", () => {
    const result = expectValidationFailure({
      schema: objectSchema({ settings: { type: "object", dependencies: { mode: ["format"] } } }),
      value: { settings: { mode: "strict" } },
    });
    expect(expectValidationIssue(result, "settings.format").allowedValues).toBeUndefined();
  });
});

describe("source-aware schema validation", () => {
  const schema = objectSchema(
    {
      credential: objectSchema({ id: { type: "string" } }, { required: ["id"] }),
      retries: { type: "integer", default: 2 },
    },
    { required: ["credential"] },
  );
  function fixture(
    selectedSchema: Parameters<typeof validateJsonSchemaValue>[0]["schema"] = schema,
  ) {
    const sourceValue = { credential: { id: "KEY" } };
    const value = { credential: "resolved-fixture-key" };
    return {
      value,
      sourceValue,
      validate: (overrides: Partial<Parameters<typeof validateJsonSchemaValue>[0]> = {}) =>
        validateJsonSchemaValue({
          schema: selectedSchema,
          sourceValue,
          value,
          applyDefaults: true,
          ...overrides,
        }),
    };
  }

  it("validates uncached persisted references and defaults runtime without mutating either", () => {
    const { value, sourceValue, validate } = fixture();
    expect(validate({ cache: false })).toEqual({ ok: true, value: { ...value, retries: 2 } });
    expect(validate({ cache: false, sourceValue: { credential: "plaintext" } }).ok).toBe(false);
    expect(validate({ cache: false, sourceValue: null }).ok).toBe(false);
    expect(sourceValue).toEqual({ credential: { id: "KEY" } });
    expect(value).toEqual({ credential: "resolved-fixture-key" });
  });

  it("preserves the runtime identity without applicable defaults", () => {
    const { value, validate } = fixture({
      ...schema,
      properties: { credential: schema.properties.credential },
    });
    const result = validate();
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
      [jsonSchemaThenKeyword]: { required: ["confirmation"] },
    };
    const { value, sourceValue, validate } = fixture(conditional);
    expect(validate({ applyDefaults: false })).toEqual({ ok: true, value });
    const expected = { ok: true, value: { ...value, retries: 2, enabled: true } };
    const compile = vi.spyOn(globalThis, "Function");
    try {
      expect(validate({ schema: structuredClone(conditional) })).toEqual(expected);
      expect(validate({ sourceValue: { ...sourceValue, enabled: true } }).ok).toBe(false);
      expect(validate()).toEqual(expected);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });

  it("rejects invalid source even when the runtime itself matches the schema", () => {
    const { validate } = fixture();
    const result = validate({
      sourceValue: { credential: "invalid-plaintext-fixture" },
      value: { credential: { id: "VALID" } },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("invalid-plaintext-fixture");
  });

  it("uses source-selected conditional defaults in nested runtime objects and arrays", () => {
    const settings = {
      ...schema,
      properties: { ...schema.properties, endpoint: { type: "string" } },
      if: fields({ credential: { type: "object" } }, ["credential"]),
      [jsonSchemaThenKeyword]: fields({ endpoint: { default: "https://reference.example" } }),
      else: fields({ endpoint: { default: "https://plaintext.example" } }),
    };
    const { value: account, sourceValue: sourceAccount, validate } = fixture();
    const value = { accounts: [account] },
      sourceValue = { accounts: [sourceAccount] };
    expect(
      validate({
        schema: objectSchema({ accounts: { type: "array", items: settings } }),
        value,
        sourceValue,
      }),
    ).toEqual({
      ok: true,
      value: { accounts: [{ ...account, retries: 2, endpoint: "https://reference.example" }] },
    });
    expect(sourceValue).toEqual({ accounts: [{ credential: { id: "KEY" } }] });
    expect(value).toEqual({ accounts: [{ credential: "resolved-fixture-key" }] });
  });

  it("preserves runtime overrides and removed references while transferring source defaults", () => {
    const { validate } = fixture();
    const sourceValue = { credential: { id: "KEY" }, accounts: [{ credential: { id: "OTHER" } }] };
    const value = { retries: 9, accounts: [{ credential: "resolved-fixture-key" }] };
    const before = structuredClone({ sourceValue, value });
    expect(
      validate({
        schema: {
          ...schema,
          properties: { ...schema.properties, accounts: { type: "array", items: schema } },
        },
        value,
        sourceValue,
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

const dependencySchema = (trigger: string) => ({
  type: "object",
  dependentRequired: { [trigger]: ["left", "right"] },
});

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

  it("reports all missing properties without splitting literal names", () => {
    const names = ["endpoint", "token", "dot.name", "slash/name", "tilde~1name", "", "<root>"];
    const result = expectValidationFailure({
      schema: requiredSchema(names, "settings"),
      value: { settings: {} },
    });
    expect(result.errors).toEqual(
      names.map((name) =>
        requiredDiagnostic(name ? `settings.${name}` : "settings", ["settings", name], name),
      ),
    );
  });

  it("sanitizes terminal controls in a later missing field without changing raw diagnostics", () => {
    const name = "evil\nkey\t\x1b[31mred\x1b[0m";
    const result = expectValidationFailure({
      schema: requiredSchema(["endpoint", name]),
      value: {},
    });
    expect(result.errors).toEqual([
      requiredDiagnostic("endpoint", ["endpoint"], "endpoint"),
      diagnostic(
        name,
        [name],
        `must have required property '${name}'`,
        "evil\\nkey\\tred: must have required property 'evil\\nkey\\tred'",
      ),
    ]);
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
          "room/one": dependencySchema("literal"),
          room: objectSchema({ one: dependencySchema("nested") }),
          "room~1one": dependencySchema("tilde"),
          "room%2Fone": dependencySchema("percent"),
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
