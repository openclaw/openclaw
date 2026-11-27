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
    // Every key is required, so overflow shortens types instead of dropping keys.
    expect(input).toContain("field_11: number }");
    expect(input).not.toContain("Description stays deferred.");
    expect(input.length).toBeLessThanOrEqual(300);
    expect(outputHint(schema)).toContain("field_11: number");
    expect(outputHint(schema)).not.toContain("/*");
  });

  it("keeps input hints small while allowing larger exact output contracts", () => {
    const schema = fields(16, (i) => `field_${String(i).padStart(2, "0")}_with_long_name`);

    // Required names alone overflow the input budget; a partial list would read as complete.
    expect(inputHint(schema)).toBe("{ ... }");
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
      delta <= 0 ? expected : limit === 300 ? '{ a: string; "z😀": string }' : undefined,
    );
  });

  it("keeps required details on overflow and adds optional root fields only when they fit", () => {
    const item = closedObject({
      text: Type.String(),
      kind: Type.Union(["fact", "preference", "decision"].map((kind) => Type.Literal(kind))),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`optional_${i}`, Type.Optional(Type.String())]),
      ),
    });
    const schema = closedObject({
      requestId: Type.String(),
      attribution: Type.String(),
      items: Type.Array(item),
      note: Type.Optional(Type.String()),
    });
    expect(inputHint(schema)).toBe(
      '{ attribution: string; items: Array<{ kind: "fact" | "preference" | "decision"; text: string; ... }>; requestId: string; note?: string; ... }',
    );

    // Union variants keep their required keys instead of collapsing to unknown.
    const destination = closedObject({
      destination: Type.Union([
        closedObject({ id: Type.String(), revision: Type.Optional(Type.Integer()) }),
        closedObject({ title: Type.String() }),
      ]),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`optional_${i}`, Type.Optional(Type.String())]),
      ),
    });
    expect(inputHint(destination)).toBe(
      "{ destination: { id: string; ... } | { title: string }; ... }",
    );

    const long = Type.Optional(Type.Literal("x".repeat(280)));
    const nullable = {
      ...closedObject({ id: Type.String(), extra: Type.Optional(Type.String()) }),
      nullable: true,
    };
    expect(inputHint(closedObject({ choice: nullable, note: long }))).toBe(
      "{ choice: { id: string; ... } | null; note?: string; ... }",
    );
    expect(
      inputHint(
        Type.Union([
          closedObject({ id: Type.String(), extra: long }),
          closedObject({ name: Type.String() }),
        ]),
      ),
    ).toBe("{ id: string; ... } | { name: string }");
  });

  it("keeps optional mutation fields visible without exceeding the input hint budget", () => {
    const schema = closedObject({
      expectedHash: Type.String(),
      expectedRevision: Type.Integer({ minimum: 1 }),
      id: Type.String(),
      reason: Type.String(),
      requestId: Type.String(),
      expectedVaultId: Type.Optional(Type.String()),
      annotations: Type.Optional(fields(12, (i) => `annotation_${i}`)),
      entities: Type.Optional(Type.Array(Type.String())),
      addEvidence: Type.Optional(Type.Array(fields(12, (i) => `evidence_${i}`))),
    });
    const hint = inputHint(schema);
    expect(hint).toContain("expectedRevision: number /* integer, >= 1 */");
    expect(hint).toContain("requestId: string");
    expect(hint).toContain("entities?: Array<...>");
    expect(hint).toContain("addEvidence?: Array<...>");
    expect(hint).toContain("annotations?: { ... }");
    expect(hint.length).toBeLessThanOrEqual(300);
    expect(outputHint(schema)).toContain("evidence_11: string");
  });

  it("shortens required types that still overflow and keeps the result bounded", () => {
    const item = closedObject({
      text: Type.String(),
      kind: Type.Union(["fact", "preference", "decision"].map((kind) => Type.Literal(kind))),
      count: Type.Integer({ minimum: 0, maximum: 100 }),
    });
    const wide = closedObject(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`group_${i}`, Type.Array(item)])),
    );
    const input = inputHint(wide);
    expect(input).toMatch(
      /^\{ group_0: Array<\{ count: number \/\* integer.*; group_7: Array<\{ \.\.\. \}> \}$/u,
    );
    expect(input.length).toBeLessThanOrEqual(300);

    // Short required types cost no more than their elided form.
    const manyRequired = closedObject({
      ...Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [
          `field_${String(i).padStart(3, "0")}`,
          Type.String(),
        ]),
      ),
      optional_extra: Type.Optional(Type.String()),
    });
    expect(inputHint(manyRequired)).toMatch(
      /^\{ field_000: string; .*; field_014: string; \.\.\. \}$/u,
    );

    // An open object's trailing ellipsis counts against the budget.
    const open = Type.Object(
      { a: Type.String(), z: Type.Literal("x".repeat(276)) },
      { additionalProperties: true },
    );
    expect(inputHint(open)).toBe("{ a: string; z: string; ... }");
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
