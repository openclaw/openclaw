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
