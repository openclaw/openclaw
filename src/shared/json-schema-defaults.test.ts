import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { afterEach, describe, expect, it } from "vitest";
import { applyJsonSchemaDefaults, findJsonSchemaShapeError } from "./json-schema-defaults.js";

describe("normalizeJsonSchemaForTypeBox", () => {
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
        "^https:": {
          allOf: [{ minLength: 1 }, { maxLength: 10 }],
        },
      },
    });
  });

  it.each(["__proto__"])("preserves pattern property key %s", (pattern) => {
    const normalized = normalizeJsonSchemaForTypeBox({
      type: "object",
      patternProperties: Object.fromEntries([[pattern, { type: "string" }]]),
    });

    expect(normalized).toMatchObject({
      patternProperties: Object.fromEntries([[pattern, { type: "string" }]]),
    });
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

  it.each(["#foo%zz"])(
    "reports malformed percent-encoding in local ref anchor %s as unresolved instead of throwing",
    (ref) => {
      expect(findJsonSchemaShapeError({ $ref: ref })).toBe("<schema>.$ref: unresolved ref");
    },
  );

  it.each([{ type: ["string", undefined] }])(
    "rejects undefined type union entries: $type",
    ({ type }) => {
      expect(findJsonSchemaShapeError({ type })).toBe(
        "<schema>.type: unsupported JSON Schema type",
      );
    },
  );
});

describe("applyJsonSchemaDefaults prototype safety", () => {
  const readPollution = () => (Object.prototype as Record<string, unknown>).polluted;

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it("does not pollute Object.prototype through a __proto__ property schema", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"object","properties":{"polluted":{"default":"yes"}}}}}',
    );

    const result = applyJsonSchemaDefaults(schema, {});

    expect(readPollution()).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(result, "polluted")).toBe(false);
  });

  it("does not pollute Object.prototype through a __proto__ pattern property schema", () => {
    const schema = JSON.parse(
      '{"type":"object","patternProperties":{".*":{"type":"object","properties":{"polluted":{"default":"yes"}}}}}',
    );
    const value = JSON.parse('{"__proto__":{}}');

    applyJsonSchemaDefaults(schema, value);

    expect(readPollution()).toBeUndefined();
  });

  it("does not pollute Object.prototype through a __proto__ additional property schema", () => {
    const schema = JSON.parse(
      '{"type":"object","additionalProperties":{"type":"object","properties":{"polluted":{"default":"yes"}}}}',
    );
    const value = JSON.parse('{"__proto__":{}}');

    applyJsonSchemaDefaults(schema, value);

    expect(readPollution()).toBeUndefined();
  });
});

describe("JSON Schema child traversal", () => {
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

  it.each(["nested"])("does not cross the nested resource boundary %j for anchors", ($id) => {
    const schema = {
      $ref: "#target",
      $defs: { nested: { $id, $anchor: "target", default: "not local" } },
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
    const schema = {
      properties: { a: { default: true } },
      dependentSchemas: Object.fromEntries(
        (
          [
            ["e", "f"],
            ["d", "e"],
            ["c", "d"],
            ["b", "c"],
            ["a", "b"],
          ] as const
        ).map(([trigger, added]) => [trigger, { properties: { [added]: { default: true } } }]),
      ),
    };

    expect(applyJsonSchemaDefaults(schema, {})).toEqual({
      a: true,
      b: true,
      c: true,
      d: true,
      e: true,
      f: true,
    });
  });
});
