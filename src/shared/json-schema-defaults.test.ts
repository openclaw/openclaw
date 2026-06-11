import { describe, expect, it } from "vitest";
import { normalizeJsonSchemaForTypeBox } from "./json-schema-defaults.js";

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
});
