import { Type, type TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import {
  compactToolInputHint as inputHint,
  compactToolOutputHint as outputHint,
  toolSchemaDeclaration as declaration,
} from "./tool-schema-hints.js";

function closedObject<T extends Parameters<typeof Type.Object>[0]>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}
function fields(count: number, name: (index: number) => string, value: TSchema = Type.String()) {
  return closedObject(
    Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), value])),
  );
}
const closedIdSchema = closedObject({ id: Type.String() });

describe("tool schema hints", () => {
  it("renders frozen nested schemas without mutating their key order", () => {
    const schema = Object.freeze({
      type: "object",
      properties: Object.freeze({
        z: Object.freeze({ type: "string" }),
        a: Object.freeze({
          type: "object",
          properties: Object.freeze({ b: Object.freeze({ type: "boolean" }) }),
          additionalProperties: false,
        }),
      }),
      required: Object.freeze(["z", "a"]),
      additionalProperties: false,
    });
    expect(declaration(schema)).toBe("{ a: { b?: boolean }; z: string }");
    expect(Object.keys(schema.properties)).toEqual(["z", "a"]);
    expect(schema.required).toEqual(["z", "a"]);
  });

  it("keeps unknown leaves and dictionaries honest in full declarations", () => {
    const schema = closedObject({
      value: Type.Unknown(),
      rows: Type.Record(Type.String(), Type.Number()),
      opaque: { $ref: "#/$defs/hidden" },
    });
    expect(declaration(schema)).toBe("{ opaque: unknown; rows: unknown; value: unknown }");
    expect(declaration({ type: "object", additionalProperties: { type: "string" } })).toBe(
      "{ [key: string]: string }",
    );
    expect(declaration(undefined)).toBe("unknown");
  });

  it.each([{ minimum: "1" }, { maximum: Number.POSITIVE_INFINITY }])(
    "defers malformed numeric bounds instead of inventing constraints: %j",
    (bounds) => {
      expect(inputHint({ type: "number", ...bounds })).toBe("unknown");
    },
  );

  it("charges complete numeric annotations to the existing input budget", () => {
    const schema = fields(
      12,
      (i) => `field_${String(i).padStart(2, "0")}`,
      Type.Integer({
        minimum: 0,
        maximum: 100,
        exclusiveMinimum: 1,
        exclusiveMaximum: 99,
        description: "Description stays deferred.",
      }),
    );
    const input = inputHint(schema);

    expect(input).toContain("field_00: number /* integer, >= 0, <= 100, > 1, < 99 */");
    expect(input).toContain("...");
    expect(input).not.toContain("Description stays deferred.");
    expect(input.length).toBeLessThanOrEqual(300);
    expect(outputHint(schema)).toContain("field_11: number");
    expect(outputHint(schema)).not.toContain("/*");
  });

  it("keeps input hints small while allowing larger exact output contracts", () => {
    const schema = fields(16, (i) => `field_${String(i).padStart(2, "0")}_with_long_name`);

    expect(inputHint(schema)).toBe("unknown");
    expect(outputHint(schema)).toContain("field_15_with_long_name: string");
  });

  it.each([
    { limit: 300, delta: 0 },
    { limit: 300, delta: 1 },
    { limit: 800, delta: 0 },
    { limit: 800, delta: 1 },
  ])("preserves the $limit UTF-16 boundary at offset $delta", ({ limit, delta }) => {
    const literal = "x".repeat(limit - 24 + delta);
    const schema = closedObject({ a: Type.String(), "z😀": Type.Literal(literal) });
    const render = limit === 300 ? inputHint : outputHint;
    const expected = `{ a: string; "z😀": "${literal}" }`;

    expect(expected.length).toBe(limit + delta);
    expect(render(schema)).toBe(
      delta <= 0 ? expected : limit === 300 ? "{ a: string; ... }" : undefined,
    );
  });

  it("includes null in AJV-style nullable output hints", () => {
    expect(outputHint({ type: "string", nullable: true })).toBe("string | null");
    expect(outputHint({ ...closedIdSchema, nullable: true })).toBe("{ id: string } | null");
    expect(outputHint({ type: "string", nullable: true, enum: ["ready"] })).toBe('"ready"');
    expect(outputHint({ type: "string", nullable: "yes" })).toBeUndefined();
  });

  it("omits incomplete output hints instead of inviting field guesses", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;

    for (const schema of [
      cyclic,
      { $ref: "#/$defs/result" },
      { anyOf: [] },
      Type.Union(Array.from({ length: 9 }, (_, index) => Type.Literal(index))),
      Type.Union(
        Array.from({ length: 6 }, (_, index) => closedObject({ kind: Type.Literal(index) })),
      ),
      { ...closedIdSchema, oneOf: [] },
      {
        ...closedIdSchema,
        anyOf: Array.from({ length: 5 }, (_unused, index) => ({ const: index })),
      },
      { ...closedIdSchema, anyOf: [{ const: "a" }], oneOf: [{ const: "b" }] },
      Type.Object({ id: Type.String() }),
      {
        type: "object",
        properties: {},
        patternProperties: { "^item_": { type: "number" } },
        additionalProperties: false,
      },
    ]) {
      expect(outputHint(schema)).toBeUndefined();
    }

    const oversized = fields(32, (i) => `field_${i}`);
    expect(outputHint(oversized)).toBeUndefined();
    expect(inputHint(oversized)).toContain("...");

    const hugeName = closedObject({ ["x".repeat(10_000)]: Type.String() });
    expect(outputHint(hugeName)).toBeUndefined();
    expect(inputHint(hugeName)).toBe("{ ... }");
  });
});
