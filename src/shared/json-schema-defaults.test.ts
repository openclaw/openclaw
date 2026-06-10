import { describe, expect, it } from "vitest";
import {
  applyJsonSchemaDefaults,
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "./json-schema-defaults.js";
import type { JsonSchemaObject } from "./json-schema.types.js";

function unreadableSchemaMap(): Record<string, JsonSchemaObject> {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("schema map exploded");
      },
    },
  ) as Record<string, JsonSchemaObject>;
}

describe("json schema defaults", () => {
  it("bounds unreadable schema maps during shape checks and default projection", () => {
    const schema = {
      type: "object",
      properties: unreadableSchemaMap(),
    } as JsonSchemaObject;
    const value = { existing: true };

    expect(findJsonSchemaShapeError(schema)).toBe("<schema>.properties: unreadable schema map");
    expect(normalizeJsonSchemaForTypeBox(schema)).toEqual({
      type: "object",
      properties: {},
    });
    expect(applyJsonSchemaDefaults(schema, value)).toBe(value);
  });

  it("does not partially apply sibling defaults when a schema map is unreadable", () => {
    const schema = {
      type: "object",
      properties: unreadableSchemaMap(),
      dependentSchemas: {
        existing: {
          properties: {
            added: { default: true },
          },
        },
      },
    } as JsonSchemaObject;
    const value = { existing: true };

    expect(applyJsonSchemaDefaults(schema, value)).toEqual({ existing: true });
    expect(value).toEqual({ existing: true });
  });

  it("does not return partially mutated values when a later default cannot be cloned", () => {
    const schema = {
      type: "object",
      properties: {
        first: { default: "applied before failure" },
        second: { default: () => "not cloneable" },
      },
    } as unknown as JsonSchemaObject;
    const value = {};

    expect(applyJsonSchemaDefaults(schema, value)).toBe(value);
    expect(value).toEqual({});
  });
});
