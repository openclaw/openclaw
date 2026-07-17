/** Tests bounded deterministic tool schema hints, including adversarial shapes. */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { compactToolInputHint, compactToolOutputHint } from "./tool-schema-hints.js";

describe("tool schema hints", () => {
  it("renders nested declared outputs as compact TypeScript shapes", () => {
    const outputSchema = Type.Array(
      Type.Object(
        {
          id: Type.String(),
          metrics: Type.Object(
            {
              paid: Type.Boolean(),
              tons: Type.Number(),
            },
            { additionalProperties: false },
          ),
          state: Type.Union([Type.Literal("ready"), Type.Literal("held")]),
        },
        { additionalProperties: false },
      ),
    );

    expect(compactToolOutputHint(outputSchema)).toBe(
      'Array<{ id: string; metrics: { paid: boolean; tons: number }; state: "ready" | "held" }>',
    );
  });

  it("includes null in AJV-style nullable output hints", () => {
    expect(compactToolOutputHint({ type: "string", nullable: true })).toBe("string | null");
    expect(
      compactToolOutputHint({
        type: "object",
        nullable: true,
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      }),
    ).toBe("{ id: string } | null");
    expect(compactToolOutputHint({ type: "string", nullable: true, enum: ["ready"] })).toBe(
      '"ready"',
    );
    expect(compactToolOutputHint({ type: "string", nullable: "yes" })).toBeUndefined();
  });

  it("orders required and optional fields deterministically", () => {
    const first = {
      type: "object",
      properties: {
        optional: { type: "boolean" },
        beta: { type: "number" },
        alpha: { type: "string" },
      },
      required: ["beta", "alpha"],
    };
    const second = {
      type: "object",
      properties: {
        alpha: { type: "string" },
        beta: { type: "number" },
        optional: { type: "boolean" },
      },
      required: ["alpha", "beta"],
    };

    expect(compactToolInputHint(first)).toBe("{ alpha: string; beta: number; optional?: boolean }");
    expect(compactToolInputHint(second)).toBe(compactToolInputHint(first));
  });

  it("omits incomplete output hints instead of inviting field guesses", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    (cyclic.properties as Record<string, unknown>).self = cyclic;

    expect(compactToolOutputHint(cyclic)).toBeUndefined();
    expect(compactToolOutputHint({ $ref: "#/$defs/result" })).toBeUndefined();
    expect(compactToolOutputHint({ anyOf: [] })).toBeUndefined();
    const closedBaseShape = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    expect(compactToolOutputHint({ ...closedBaseShape, oneOf: [] })).toBeUndefined();
    expect(
      compactToolOutputHint({
        ...closedBaseShape,
        anyOf: Array.from({ length: 5 }, (_unused, index) => ({ const: index })),
      }),
    ).toBeUndefined();
    expect(
      compactToolOutputHint({
        ...closedBaseShape,
        anyOf: [{ const: "a" }],
        oneOf: [{ const: "b" }],
      }),
    ).toBeUndefined();
    expect(compactToolOutputHint(Type.Object({ id: Type.String() }))).toBeUndefined();
    expect(
      compactToolOutputHint({
        type: "object",
        properties: {},
        patternProperties: { "^item_": { type: "number" } },
        additionalProperties: false,
      }),
    ).toBeUndefined();

    const oversized = Type.Object(
      Object.fromEntries(
        Array.from({ length: 32 }, (_unused, index) => [`field_${index}`, Type.String()]),
      ),
      { additionalProperties: false },
    );
    expect(compactToolOutputHint(oversized)).toBeUndefined();
    expect(compactToolInputHint(oversized)).toContain("...");

    const hugeName = Type.Object(
      { ["x".repeat(10_000)]: Type.String() },
      { additionalProperties: false },
    );
    expect(compactToolOutputHint(hugeName)).toBeUndefined();
    expect(compactToolInputHint(hugeName)).toBe("{ ... }");
  });

  it('keeps complete fields and literals containing the word "unknown"', () => {
    const outputSchema = Type.Object(
      {
        state: Type.Union([Type.Literal("known"), Type.Literal("unknown")]),
        unknownReason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    );

    expect(compactToolOutputHint(outputSchema)).toBe(
      '{ state: "known" | "unknown"; unknownReason?: string }',
    );
  });

  it("bounds deterministic hints across a large adversarial catalog", () => {
    const schemas = Array.from({ length: 1_000 }, (_, index) =>
      Type.Array(
        Type.Object(
          Object.fromEntries(
            Array.from({ length: 32 }, (_unused, propertyIndex) => [
              `field_${index}_${propertyIndex}`,
              Type.Optional(Type.String()),
            ]),
          ),
          { additionalProperties: index % 2 === 0 },
        ),
      ),
    );

    const first = schemas.map(compactToolInputHint);
    const second = schemas.map(compactToolInputHint);

    expect(second).toEqual(first);
    expect(first.every((hint) => hint.length <= 300)).toBe(true);
    expect(schemas.every((schema) => compactToolOutputHint(schema) === undefined)).toBe(true);
  });
});
