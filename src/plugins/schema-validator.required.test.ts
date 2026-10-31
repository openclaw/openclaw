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
type ValidationInput = Parameters<typeof validateJsonSchemaValue>[0];
type ValidationFailure = Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }>;
type Properties = Record<string, unknown>;

const fields = (properties: Properties, required?: string[]) => ({
  properties,
  ...(required ? { required } : {}),
});
const objectSchema = (properties: Properties, rest: Properties = {}) => ({
  type: "object",
  properties,
  ...rest,
});
const conditionalSchema = (condition: object, branch: object, rest: Properties = {}) => ({
  type: "object",
  ...rest,
  if: condition,
  [jsonSchemaThenKeyword]: branch,
});
const defaulted = (type: string, value: unknown) => ({ type, default: value });
const apiCondition = () => fields({ kind: { const: "api" } }, ["kind"]);
const defaultField = (name: string, type: string, value: unknown, required = true) =>
  fields({ [name]: defaulted(type, value) }, required ? [name] : undefined);
const modeDefaults = () => defaultField("mode", "string", "auto");
const requiredFlagDefault = (name: string) => defaultField(name, "boolean", true);
const endpointDefaults = (required = false) =>
  defaultField("endpoint", "string", "https://example.com", required);

function expectValidationFailure(params: ValidationInput): ValidationFailure {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

function expectValue(
  schema: ValidationInput["schema"],
  value: unknown,
  expectedValue: unknown,
  applyDefaults = true,
) {
  expect(validateJsonSchemaValue({ schema, value, applyDefaults })).toEqual({
    ok: true,
    value: expectedValue,
  });
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
    ] as const) {
      expect(() => validateJsonSchemaValue({ schema, value: "anything" })).toThrow(
        "invalid schema",
      );
    }
  });

  it("accepts valid local refs to boolean schemas and anchors", () => {
    expectValidationFailure({
      schema: { $defs: { Never: false }, $ref: "#/$defs/Never" },
      value: "anything",
    });

    const string = { type: "string" };
    const anchored = { $defs: { Value: { ...string, $anchor: "value" } }, $ref: "#value" };
    for (const schema of [
      { $defs: { Other: { $id: "other", ...anchored } }, $ref: "#/$defs/Other" },
      {
        $id: "https://example.com/root/",
        $defs: { Value: { ...string, $id: "value" } },
        $ref: "https://example.com/root/value",
      },
      { $id: "", $defs: { Value: string }, $ref: "#/$defs/Value" },
      { $defs: { Value: { ...string, $dynamicAnchor: "value" } }, $dynamicRef: "#value" },
    ]) {
      expectValue(schema, "ok", "ok", false);
    }

    expectValidationFailure({
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
    expectValue(tuple, ["mode", 1], ["mode", 1], false);
    for (const items of [{ items: pair, additionalItems: false }, { prefixItems: pair }]) {
      expectValue({ type: "array", minItems: 2, ...items }, [], ["mode", 1]);
    }
    expectValue(
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
    const withEndpoint = (schema: ValidationInput["schema"], value = { kind: "api" }) =>
      expectValue(schema, value, { ...value, endpoint: "https://example.com" });
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

    expectValue(
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
    expectValue(
      conditionalSchema(
        fields({ kind: { $ref: "#/properties/kind" } }, ["kind"]),
        endpointDefaults(true),
        { properties: { kind: kindReference } },
      ),
      { kind: { value: "api" } },
      { kind: { value: "api" }, endpoint: "https://example.com" },
    );
    expectValue(
      conditionalSchema(apiCondition(), endpointDefaults(), {
        properties: defaultKind,
        else: fields({ path: defaulted("string", "/tmp") }),
      }),
      {},
      { kind: "api", endpoint: "https://example.com" },
    );
    expectValue(modeConditional, {}, { mode: "auto" });
    expectValue(flagConditional, {}, { flag: true });
    expectValidationFailure({
      schema: flagConditional,
      value: { flag: true },
      applyDefaults: true,
    });
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
    expectValue(
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
    expectValue(
      conditionalSchema(apiCondition(), requiredFlagDefault("flag"), {
        properties: kind,
        dependencies: { flag: modeDefaults() },
      }),
      { kind: "api" },
      { kind: "api", flag: true, mode: "auto" },
    );
    expectValue(
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
    const issue = expectValidationFailure({
      schema: objectSchema({ mode: property }, { required: ["mode"] }),
      value: { mode: "not-listed" },
    }).errors[0]!;
    expect(issue.path).toBe("mode");
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
    expect(result.errors).toEqual([expect.objectContaining({ path: "settings.format" })]);
    expect(result.errors[0]?.allowedValues).toBeUndefined();
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
  function fixture(selectedSchema: ValidationInput["schema"] = schema) {
    const sourceValue = { credential: { id: "KEY" } };
    const value = { credential: "resolved-fixture-key" };
    return {
      value,
      sourceValue,
      validate: (overrides: Partial<ValidationInput> = {}) =>
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
    const literalProperties = ["slash/name", "tilde~1name", "", "<root>"];
    const result = expectValidationFailure({
      schema: objectSchema({
        "dot.name": { type: "number" },
        dot: objectSchema({ name: { type: "number" } }),
        ...Object.fromEntries(literalProperties.map((name) => [name, { type: "number" }])),
        items: { type: "array", items: { type: "number" } },
      }),
      value: {
        "dot.name": "invalid",
        dot: { name: "invalid" },
        ...Object.fromEntries(literalProperties.map((name) => [name, "invalid"])),
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
    [
      "all dependencies missing in one condition",
      { type: "object", dependentRequired: { a: ["b", "c"] } },
      { a: true },
      [dependency("<root>", [], "a", "b, c")],
    ],
    [
      "root with the first dependency already present",
      { type: "object", dependencies: { a: ["b", "c"] } },
      { a: true, b: "present" },
      [dependency("<root>", [], "a", "b, c")],
    ],
    [
      "literal and nested containers with distinct conditions",
      objectSchema({
        "room/one": dependencySchema("literal"),
        room: objectSchema({ one: dependencySchema("nested") }),
        "room~1one": dependencySchema("tilde"),
        "room%2Fone": dependencySchema("percent"),
      }),
      {
        "room/one": { literal: true, left: "present" },
        room: { one: { nested: true, right: "present" } },
        "room~1one": { tilde: true, left: "present" },
        "room%2Fone": { percent: true, right: "present" },
      },
      [
        dependency("room.one", ["room/one"], "literal"),
        dependency("room.one", ["room", "one"], "nested"),
        dependency("room~1one", ["room~1one"], "tilde"),
        dependency("room%2Fone", ["room%2Fone"], "percent"),
      ],
    ],
  ] as const)(
    "preserves the dependency condition at %s",
    (_title, schema, value, expectedErrors) => {
      expect(expectValidationFailure({ schema, value }).errors).toEqual(expectedErrors);
    },
  );
});
