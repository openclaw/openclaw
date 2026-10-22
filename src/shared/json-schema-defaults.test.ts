import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { afterEach, describe, expect, it } from "vitest";
import { applyJsonSchemaDefaults, findJsonSchemaShapeError } from "./json-schema-defaults.js";

describe("JSON Schema helpers", () => {
  it("combines pattern properties that collide after unicode repair", () => {
    const normalized = normalizeJsonSchemaForTypeBox({
      type: "object",
      patternProperties: {
        "^https:": { minLength: 1 },
        "^https\\:": { maxLength: 10 },
      },
    });

    expect(normalized).toMatchObject({
      patternProperties: {
        "^https:": { allOf: [{ minLength: 1 }, { maxLength: 10 }] },
      },
    });
  });

  it("preserves pattern property key __proto__", () => {
    const properties = () => Object.fromEntries([["__proto__", { type: "string" }]]);
    const normalized = normalizeJsonSchemaForTypeBox({
      type: "object",
      patternProperties: properties(),
    });
    expect(normalized).toMatchObject({ patternProperties: properties() });
  });

  it("resolves local refs to array entries beyond config path index limits", () => {
    const prefixItems: (boolean | { type: string })[] = Array.from({ length: 100_002 }, () => true);
    prefixItems[100_001] = { type: "string" };

    expect(
      findJsonSchemaShapeError({
        type: "array",
        prefixItems,
        items: { $ref: "#/prefixItems/100001" },
      }),
    ).toBeUndefined();
  });

  it("reports malformed percent-encoding in local ref anchors as unresolved", () => {
    expect(findJsonSchemaShapeError({ $ref: "#foo%zz" })).toBe("<schema>.$ref: unresolved ref");
  });

  it("rejects undefined type union entries", () => {
    expect(findJsonSchemaShapeError({ type: ["string", undefined] })).toBe(
      "<schema>.type: unsupported JSON Schema type",
    );
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
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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
});
