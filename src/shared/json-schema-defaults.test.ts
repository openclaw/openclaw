import {
  isJsonSchemaValueValid,
  jsonSchemaValuesEqual,
  normalizeJsonSchemaForTypeBox,
} from "@openclaw/normalization-core/json-schema";
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

  it.each(["constructor", "toString", "__proto__"])(
    "preserves pattern property key %s",
    (pattern) => {
      const normalized = normalizeJsonSchemaForTypeBox({
        type: "object",
        patternProperties: Object.fromEntries([[pattern, { type: "string" }]]),
      });

      expect(normalized).toMatchObject({
        patternProperties: Object.fromEntries([[pattern, { type: "string" }]]),
      });
    },
  );

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

  it.each(["#%", "#foo%zz", "#anchor%"])(
    "reports malformed percent-encoding in local ref anchor %s as unresolved instead of throwing",
    (ref) => {
      expect(findJsonSchemaShapeError({ $ref: ref })).toBe("<schema>.$ref: unresolved ref");
    },
  );

  it("preserves Control UI nullable value semantics", () => {
    const schema = {
      type: "string",
      enum: ["fixed"],
      nullable: true,
      enumIncludesNull: true,
    };

    expect(isJsonSchemaValueValid(schema, "fixed")).toBe(true);
    expect(isJsonSchemaValueValid(schema, null)).toBe(true);
    expect(isJsonSchemaValueValid(schema, "other")).toBe(false);
    expect(isJsonSchemaValueValid({ nullable: true }, null)).toBe(true);
    expect(isJsonSchemaValueValid({ type: "string", nullable: true, minLength: 2 }, null)).toBe(
      true,
    );
    expect(isJsonSchemaValueValid({ type: "string", nullable: true, const: "fixed" }, null)).toBe(
      false,
    );
    expect(isJsonSchemaValueValid({ nullable: true, enum: ["fixed"] }, null)).toBe(false);
    expect(isJsonSchemaValueValid({ enum: ["fixed"], enumIncludesNull: true }, null)).toBe(false);
  });

  it("keeps schema resources outside expanded type branches", () => {
    const schema = {
      $id: "https://example.test/config",
      $defs: {
        value: { type: "string" },
      },
      type: ["object", "null"],
      properties: {
        value: { $ref: "#/$defs/value" },
      },
      required: ["value"],
    };

    expect(normalizeJsonSchemaForTypeBox(schema)).toEqual({
      $id: "https://example.test/config",
      $defs: {
        value: { type: "string" },
      },
      anyOf: [
        {
          properties: {
            value: { $ref: "#/$defs/value" },
          },
          required: ["value"],
          type: "object",
        },
        {
          properties: {
            value: { $ref: "#/$defs/value" },
          },
          required: ["value"],
          type: "null",
        },
      ],
    });
    expect(isJsonSchemaValueValid(schema, { value: "ok" })).toBe(true);
    expect(isJsonSchemaValueValid(schema, { value: 1 })).toBe(false);
  });

  it("rejects cyclic values without recursing indefinitely", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(isJsonSchemaValueValid({ type: "object" }, cyclic)).toBe(false);
    expect(jsonSchemaValuesEqual(cyclic, cyclic)).toBe(false);
  });

  it("rejects values that JSON serialization would change or discard", () => {
    const arrayWithExtraProperty = Object.assign(["kept"], { discarded: true });
    const invalidValues = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => "discarded",
      Symbol("discarded"),
      1n,
      { nested: undefined },
      [Number.NEGATIVE_INFINITY],
      Array(1),
      new Date(0),
      arrayWithExtraProperty,
    ];

    for (const value of invalidValues) {
      expect(isJsonSchemaValueValid({}, value)).toBe(false);
      expect(jsonSchemaValuesEqual(value, value)).toBe(false);
    }
    expect(isJsonSchemaValueValid({}, { nested: [null, true, 1, "ok"] })).toBe(true);
    expect(isJsonSchemaValueValid({}, Object.assign(Object.create(null), { value: "ok" }))).toBe(
      true,
    );
  });
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
    ["$defs", "map"],
    ["definitions", "map"],
    ["dependentSchemas", "map"],
    ["patternProperties", "map"],
    ["properties", "map"],
    ["dependencies", "map"],
    ["additionalItems", "value"],
    ["additionalProperties", "value"],
    ["contains", "value"],
    ["else", "value"],
    ["if", "value"],
    ["items", "value"],
    ["not", "value"],
    ["propertyNames", "value"],
    ["then", "value"],
    ["unevaluatedItems", "value"],
    ["unevaluatedProperties", "value"],
    ["items", "array"],
    ["allOf", "array"],
    ["anyOf", "array"],
    ["oneOf", "array"],
    ["prefixItems", "array"],
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

  it.each([
    ["$anchor", "#target"],
    ["$id", "target"],
  ])("materializes map entries but stops after the first %s match", (identifier, ref) => {
    const reads: string[] = [];
    const schema = {
      $ref: ref,
      $defs: {
        get first() {
          reads.push("first");
          return { [identifier]: "target", default: "first" };
        },
        get second() {
          reads.push("second");
          return { [identifier]: "target", default: "second" };
        },
      },
      get definitions() {
        reads.push("later group");
        return { target: { [identifier]: "target", default: "later" } };
      },
    };

    expect(applyJsonSchemaDefaults(schema, undefined)).toBe("first");
    expect(reads).toEqual(["first", "second"]);
  });

  it.each(["", "nested"])("does not cross the nested resource boundary %j for anchors", ($id) => {
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

describe("applyJsonSchemaDefaults patternProperties safety", () => {
  it("skips nested-repetition patternProperties instead of compiling them", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "(a+)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const value = { aaaaaaaaaaaaaaaaaaaaX: {} };

    const started = Date.now();
    const result = applyJsonSchemaDefaults(schema, value) as {
      aaaaaaaaaaaaaaaaaaaaX: { mode?: string };
    };
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(250);
    expect(result.aaaaaaaaaaaaaaaaaaaaX.mode).toBeUndefined();
  });

  it("still applies defaults through safe patternProperties", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^x": {
          type: "object",
          properties: {
            mode: { type: "string", default: "auto" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { x1: {} }) as {
      x1: { mode?: string };
    };
    expect(result.x1.mode).toBe("auto");
  });

  it("applies defaults through empty JSON Schema patternProperties", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "": {
          type: "object",
          properties: {
            mode: { type: "string", default: "auto" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { x: {} }) as {
      x: { mode?: string };
    };
    expect(result.x.mode).toBe("auto");
  });

  it("applies defaults through safe disjoint JSON Schema alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a|bc)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { a: {}, bc: {}, zz: {} }) as {
      a: { mode?: string };
      bc: { mode?: string };
      zz: { mode?: string };
    };
    expect(result.a.mode).toBe("keep");
    expect(result.bc.mode).toBe("keep");
    expect(result.zz.mode).toBeUndefined();
  });

  it("applies defaults through disjoint character-class alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^([ab]|cd)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { a: {}, cd: {}, zz: {} }) as {
      a: { mode?: string };
      cd: { mode?: string };
      zz: { mode?: string };
    };
    expect(result.a.mode).toBe("keep");
    expect(result.cd.mode).toBe("keep");
    expect(result.zz.mode).toBeUndefined();
  });

  it("skips nested alternatives that share a possible prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^((a|b)|bb)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { a: {}, bb: {} }) as {
      a: { mode?: string };
      bb: { mode?: string };
    };
    expect(result.a.mode).toBeUndefined();
    expect(result.bb.mode).toBeUndefined();
  });

  it("applies defaults through disjoint multi-character groups", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(ab)+(cd)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { abcd: {}, ab: {}, zz: {} }) as {
      abcd: { mode?: string };
      ab: { mode?: string };
      zz: { mode?: string };
    };
    expect(result.abcd.mode).toBe("keep");
    expect(result.ab.mode).toBeUndefined();
    expect(result.zz.mode).toBeUndefined();
  });

  it("skips hex-escape alternatives that share a decoded prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\x61|aa)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { a: {}, aa: {} }) as {
      a: { mode?: string };
      aa: { mode?: string };
    };
    expect(result.a.mode).toBeUndefined();
    expect(result.aa.mode).toBeUndefined();
  });

  it("skips non-ASCII whitespace overlapping patternProperties", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\s|[\\u00a0][\\u00a0])+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { "\u00a0": {} }) as {
      "\u00a0": { mode?: string };
    };
    expect(result["\u00a0"].mode).toBeUndefined();
  });

  it("skips unparsed alternating groups adjacent to overlapping repetitions", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a|b)+b+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { abb: {}, aa: {} }) as {
      abb: { mode?: string };
      aa: { mode?: string };
    };
    expect(result.abb.mode).toBeUndefined();
    expect(result.aa.mode).toBeUndefined();
  });

  it("skips noncapturing overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(?:a|aaa)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { a: {}, aaa: {} }) as {
      a: { mode?: string };
      aaa: { mode?: string };
    };
    expect(result.a.mode).toBeUndefined();
    expect(result.aaa.mode).toBeUndefined();
  });

  it("skips backreference alternatives that share a capture prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a)(\\1|aa)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { aaa: {} }) as {
      aaa: { mode?: string };
    };
    expect(result.aaa.mode).toBeUndefined();
  });

  it("applies defaults through disjoint alternating groups adjacent to a different repetition", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a|b)+c+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { ac: {}, bbc: {}, zz: {} }) as {
      ac: { mode?: string };
      bbc: { mode?: string };
      zz: { mode?: string };
    };
    expect(result.ac.mode).toBe("keep");
    expect(result.bbc.mode).toBe("keep");
    expect(result.zz.mode).toBeUndefined();
  });

  it("skips named backreference alternatives that share a capture prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(?<x>a)(\\k<x>|aa)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { aaa: {} }) as {
      aaa: { mode?: string };
    };
    expect(result.aaa.mode).toBeUndefined();
  });

  it("skips class-backspace alternatives that share a decoded prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^([\\b]|\\x08\\x08)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { "\b": {} }) as {
      "\b": { mode?: string };
    };
    expect(result["\b"].mode).toBeUndefined();
  });

  it("skips lookahead-hidden overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^((?!b)a|aaaa)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { a: {}, aaaa: {} }) as {
      a: { mode?: string };
      aaaa: { mode?: string };
    };
    expect(result.a.mode).toBeUndefined();
    expect(result.aaaa.mode).toBeUndefined();
  });

  it("skips braced unicode identity-plus-quantifier without u", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\u{2}|u)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { uu: {}, u: {} }) as {
      uu: { mode?: string };
      u: { mode?: string };
    };
    expect(result.uu.mode).toBeUndefined();
    expect(result.u.mode).toBeUndefined();
  });

  it("skips control-escape alternatives that share a decoded prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\cA|\\x01\\x01)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { "\x01": {} }) as {
      "\x01": { mode?: string };
    };
    expect(result["\x01"].mode).toBeUndefined();
  });

  it("skips nested alternative sequences that overlap adjacent groups", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^((ab|cd)e)+(abe)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { abeabe: {} }) as {
      abeabe: { mode?: string };
    };
    expect(result.abeabe.mode).toBeUndefined();
  });

  it("skips octal-escape alternatives that share a decoded prefix", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\141|aaaa)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { a: {} }) as {
      a: { mode?: string };
    };
    expect(result.a.mode).toBeUndefined();
  });

  it("skips collapsed overlapping sequences that keep consumed length", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^((ab|[a]b)c|abcabc)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { abcabc: {} }) as {
      abcabc: { mode?: string };
    };
    expect(result.abcabc.mode).toBeUndefined();
  });

  it("skips backreferences that hide overlapping consumed lengths", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(ab)(\\1c|abcabc)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { ababcabc: {} }) as {
      ababcabc: { mode?: string };
    };
    expect(result.ababcabc.mode).toBeUndefined();
  });

  it("skips word-boundary overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a\\Bb|abab)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { abab: {} }) as {
      abab: { mode?: string };
    };
    expect(result.abab.mode).toBeUndefined();
  });

  it("skips leftover-octal overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\1414c|a4ca4c)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { a4ca4c: {} }) as {
      a4ca4c: { mode?: string };
    };
    expect(result.a4ca4c.mode).toBeUndefined();
  });

  it("skips inline case-flag overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^((?i:a)|AA)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { AA: {} }) as {
      AA: { mode?: string };
    };
    expect(result.AA.mode).toBeUndefined();
  });

  it("skips class control-escape overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^([\\c_]|\\x1f\\x1f)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { "\x1f": {} }) as {
      "\x1f": { mode?: string };
    };
    expect(result["\x1f"].mode).toBeUndefined();
  });

  it("skips non-Unicode property identity-escape overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\p{L}c|p{L}cp{L}c)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { "p{L}c": {} }) as {
      "p{L}c": { mode?: string };
    };
    expect(result["p{L}c"].mode).toBeUndefined();
  });

  it("applies defaults through disjoint octal alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(\\141|BCD)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { aBCD: {}, zzzz: {} }) as {
      aBCD: { mode?: string };
      zzzz: { mode?: string };
    };
    expect(result.aBCD.mode).toBe("keep");
    expect(result.zzzz.mode).toBeUndefined();
  });

  it("applies defaults through deterministic groups that share a first character", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(ab)+(ac)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { abac: {}, ab: {}, zz: {} }) as {
      abac: { mode?: string };
      ab: { mode?: string };
      zz: { mode?: string };
    };
    expect(result.abac.mode).toBe("keep");
    expect(result.ab.mode).toBeUndefined();
    expect(result.zz.mode).toBeUndefined();
  });

  it("skips semantically overlapping adjacent patternProperties", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "a*[a]*$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { aaa: {} }) as {
      aaa: { mode?: string };
    };
    expect(result.aaa.mode).toBeUndefined();
  });

  it("applies defaults through a long literal patternProperties key", { timeout: 2000 }, () => {
    const key = "a".repeat(20_000);
    const schema = {
      type: "object",
      patternProperties: {
        [key]: {
          type: "object",
          properties: {
            mode: { type: "string", default: "keep" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { [key]: {}, zz: {} }) as {
      [key: string]: { mode?: string };
    };
    expect(result[key]?.mode).toBe("keep");
    expect(result.zz?.mode).toBeUndefined();
  });

  it("skips equal-length lookaround overlapping alternatives", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^(a|a(?=a))+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const result = applyJsonSchemaDefaults(schema, { aaaa: {} }) as {
      aaaa: { mode?: string };
    };
    expect(result.aaaa.mode).toBeUndefined();
  });
});
