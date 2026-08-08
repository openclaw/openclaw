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

describe("applyJsonSchemaDefaults patternProperties safety", () => {
  it("skips nested-repetition patternProperties instead of compiling them", () => {
    // Without compileSafeRegex, `(a+)+$` can hang on non-matching keys via
    // catastrophic backtracking. Defaults must not apply through unsafe keys.
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

  it("preserves whitespace-significant patternProperties sources", () => {
    // Exact "^x " must not trim to "^x", which would inject defaults into "xy".
    const schema = {
      type: "object",
      patternProperties: {
        "^x ": {
          type: "object",
          properties: {
            mode: { type: "string", default: "space" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, {
      "x y": {},
      xy: {},
    }) as {
      "x y": { mode?: string };
      xy: { mode?: string };
    };

    expect(result["x y"].mode).toBe("space");
    expect(result.xy.mode).toBeUndefined();
  });

  it("keeps whitespace-only patternProperties matching a space key", () => {
    const schema = {
      type: "object",
      patternProperties: {
        " ": {
          type: "object",
          properties: {
            mode: { type: "string", default: "blank" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, {
      "a b": {},
      ab: {},
    }) as {
      "a b": { mode?: string };
      ab: { mode?: string };
    };

    expect(result["a b"].mode).toBe("blank");
    expect(result.ab.mode).toBeUndefined();
  });
});
