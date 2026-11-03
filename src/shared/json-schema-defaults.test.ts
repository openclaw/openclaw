import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { afterEach, expect, it } from "vitest";
import { applyJsonSchemaDefaults, findJsonSchemaShapeError } from "./json-schema-defaults.js";

const shapeError = (schema: Parameters<typeof findJsonSchemaShapeError>[0], error?: string) =>
  expect(findJsonSchemaShapeError(schema)).toBe(error && `<schema>.${error}`);

it("repairs colliding patterns without losing __proto__", () => {
  const normalized = normalizeJsonSchemaForTypeBox({
    type: "object",
    patternProperties: Object.fromEntries([
      ["^https:", { minLength: 1 }],
      ["^https\\:", { maxLength: 10 }],
      ["__proto__", { type: "string" }],
    ]),
  });
  expect(normalized).toMatchObject({
    patternProperties: Object.fromEntries([
      ["^https:", { allOf: [{ minLength: 1 }, { maxLength: 10 }] }],
      ["__proto__", { type: "string" }],
    ]),
  });
});

it("resolves local refs to array entries beyond config path index limits", () => {
  const prefixItems: (boolean | { type: string })[] = Array.from({ length: 100_002 }, () => true);
  prefixItems[100_001] = { type: "string" };

  shapeError({ type: "array", prefixItems, items: { $ref: "#/prefixItems/100001" } });
});

it.each([
  [{ $ref: "#foo%zz" }, "$ref: unresolved ref"],
  [{ type: ["string", undefined] }, "type: unsupported JSON Schema type"],
])("rejects malformed schema %j", shapeError);

it("validates primitive keyword shapes in their established error order", () => {
  for (const [schema, expected] of [
    [{ minLength: 1.5 }, "minLength: expected non-negative integer"],
    [{ readOnly: "false" }, "readOnly: expected boolean"],
    [{ readOnly: "false", minLength: -1, maximum: "7", title: 7 }, "title: expected string"],
    [{ readOnly: "false", minLength: -1, maximum: "7" }, "maximum: expected number"],
    [{ readOnly: "false", minLength: -1 }, "minLength: expected non-negative integer"],
  ] as const) {
    shapeError(schema, expected);
  }
  shapeError({ title: "Title", maximum: 1.5, minLength: -0, readOnly: false });
  shapeError({ title: undefined, maximum: undefined, minLength: undefined, readOnly: undefined });
});

const readPollution = () => (Object.prototype as Record<string, unknown>).polluted;
const polluting = { type: "object", properties: { polluted: { default: "yes" } } };

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
});

it.each(["properties", "patternProperties", "additionalProperties"] as const)(
  "does not pollute Object.prototype through %s",
  (keyword) => {
    const children =
      keyword === "additionalProperties"
        ? polluting
        : Object.fromEntries([[keyword === "properties" ? "__proto__" : ".*", polluting]]);
    const value = keyword === "properties" ? {} : JSON.parse('{"__proto__":{}}');
    const result = applyJsonSchemaDefaults({ type: "object", [keyword]: children }, value);
    expect(readPollution()).toBeUndefined();
    expect(Object.hasOwn(result, "polluted")).toBe(false);
  },
);
it.each([
  ["properties", "map"],
  ["unevaluatedProperties", "value"],
  ["items", "array"],
  ["allOf", "array"],
])("resolves refs through %s (%s)", (keyword, shape) => {
  for (const [identifier, ref] of [
    ["$anchor", "#target"],
    ["$id", "target"],
  ] as const) {
    const target = { [identifier]: "target", default: "selected" };
    const child =
      shape === "map"
        ? { ignored: true, denied: false, target }
        : shape === "array"
          ? [true, false, target]
          : target;
    const schema = { $ref: ref, [keyword]: child };

    expect(findJsonSchemaShapeError(schema)).toBeUndefined();
    expect(applyJsonSchemaDefaults(schema, undefined)).toBe("selected");
  }
});

it("does not cross the nested resource boundary for anchors", () => {
  const schema = {
    $ref: "#target",
    $defs: { nested: { $id: "nested", $anchor: "target", default: "not local" } },
  };

  expect(findJsonSchemaShapeError(schema)).toBe("<schema>.$ref: unresolved ref");
  expect(applyJsonSchemaDefaults(schema, undefined)).toBeUndefined();
});

it("ignores property dependencies while resolving a schema dependency", () => {
  const schema = {
    $ref: "#target",
    dependencies: {
      empty: [],
      property: ["required"],
      schema: { $anchor: "target", default: "selected" },
    },
  };

  expect(findJsonSchemaShapeError(schema)).toBeUndefined();
  expect(applyJsonSchemaDefaults(schema, undefined)).toBe("selected");
});

it("settles reverse-ordered dependent schemas beyond the root property count", () => {
  const adds = (key: string) => ({ properties: { [key]: { default: true } } });
  const schema = {
    ...adds("a"),
    dependentSchemas: { e: adds("f"), d: adds("e"), c: adds("d"), b: adds("c"), a: adds("b") },
  };

  expect(applyJsonSchemaDefaults(schema, {})).toEqual(
    Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((key) => [key, true])),
  );
});
