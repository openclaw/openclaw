import { expect, it } from "vitest";
import { createJsonSchemaValidatorProvider } from "./json-schema-validator.js";

it("keeps reference registries and format policy with their provider", () => {
  const numeric = createJsonSchemaValidatorProvider({
    dialect: "draft7",
    formats: new Map([
      [
        "even",
        {
          check: (value: unknown) => typeof value !== "number" || value % 2 === 0,
          error: () => "must be even",
        },
      ],
    ]),
  });
  const text = createJsonSchemaValidatorProvider({ dialect: "draft7", formats: new Map() });
  const id = "https://example.test/value";
  numeric.getValidator({ $id: id, type: "number", format: "even" });
  text.getValidator({ $id: id, type: "string", format: "even" });
  const numericRef = numeric.getValidator({ $ref: id });
  const textRef = text.getValidator({ $ref: id });

  expect(numericRef.check(2)).toBe(true);
  expect(numericRef.check(3)).toBe(false);
  expect(numericRef.check("2")).toBe(false);
  expect(textRef.check("2")).toBe(true);
  expect(textRef.check(2)).toBe(false);
});

it("accepts boolean schema documents", () => {
  const provider = createJsonSchemaValidatorProvider({ dialect: "draft7", formats: new Map() });
  expect(provider.getValidator(true).check({ value: 1 })).toBe(true);
  const never = provider.getValidator(false);
  expect(never.check({ value: 1 })).toBe(false);
  expect(never.errors({ value: 1 }).length).toBeGreaterThan(0);
});

it("preserves root-ID reuse unless the consumer requires duplicate rejection", () => {
  const first = { $id: "https://example.test/result", type: "integer" };
  const second = { $id: "https://example.test/result", type: "string" };
  const reuse = createJsonSchemaValidatorProvider({ dialect: "draft7", formats: new Map() });
  expect(reuse.getValidator(first).check(3)).toBe(true);
  expect(reuse.getValidator(second).check("wrong")).toBe(false);
  const strict = createJsonSchemaValidatorProvider({
    dialect: "draft7",
    formats: new Map(),
    duplicateIds: "reject",
  });
  const original = strict.getValidator(first);
  expect(strict.getValidator(first)).toBe(original);
  expect(() => strict.getValidator(second)).toThrow(/already exists/);
});

it("admits schemas against a registered metaschema when the consumer requires it", () => {
  const provider = createJsonSchemaValidatorProvider({
    dialect: "draft7",
    formats: new Map(),
    validateSchema: true,
  });
  for (const schema of [
    { enum: [] },
    { enum: [1, 1] },
    { type: "invalid" },
    { required: ["x", "x"] },
    { $schema: "https://example.test/unknown-schema" },
    { $schema: "https://json-schema.org/draft/2020-12/schema" },
  ]) {
    expect(() => provider.getValidator(schema)).toThrow();
  }
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "integer" };
  expect(provider.getValidator(schema).check(3)).toBe(true);
  expect(provider.getValidator(schema).check("wrong")).toBe(false);
});
