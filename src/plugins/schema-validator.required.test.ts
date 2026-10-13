import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

function expectValidationFailure(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }> {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

describe("schema validator", () => {
  it.each([
    {
      title: "multiple nested fields",
      schema: {
        type: "object",
        properties: { settings: { type: "object", required: ["endpoint", "token"] } },
      },
      value: { settings: {} },
      expectedErrors: [
        {
          path: "settings.endpoint",
          message: "must have required property 'endpoint'",
          text: "settings.endpoint: must have required property 'endpoint'",
        },
        {
          path: "settings.token",
          message: "must have required property 'token'",
          text: "settings.token: must have required property 'token'",
        },
      ],
    },
    {
      title: "terminal controls in a later field",
      schema: { type: "object", required: ["endpoint", "evil\nkey\t\x1b[31mred\x1b[0m"] },
      value: {},
      expectedErrors: [
        {
          path: "endpoint",
          message: "must have required property 'endpoint'",
          text: "endpoint: must have required property 'endpoint'",
        },
        {
          path: "evil\nkey\t\x1b[31mred\x1b[0m",
          message: "must have required property 'evil\nkey\t\x1b[31mred\x1b[0m'",
          text: "evil\\nkey\\tred: must have required property 'evil\\nkey\\tred'",
        },
      ],
    },
  ])(
    "reports complete required diagnostics for $title",
    ({ title, schema, value, expectedErrors }) => {
      const result = expectValidationFailure({
        cacheKey: `schema-validator.test.required.complete.${title}`,
        schema,
        value,
      });

      expect(result.errors).toEqual(expectedErrors);
    },
  );

  describe("dependency diagnostics", () => {
    it.each([
      {
        title: "all dependencies missing in one condition",
        schema: { type: "object", dependentRequired: { a: ["b", "c"] } },
        value: { a: true },
        expectedErrors: [
          {
            path: "<root>",
            message: "must have properties b, c when property a is present",
            text: "<root>: must have properties b, c when property a is present",
          },
        ],
      },
      {
        title: "root with the first dependency already present",
        schema: { type: "object", dependencies: { a: ["b", "c"] } },
        value: { a: true, b: "present" },
        expectedErrors: [
          {
            path: "<root>",
            message: "must have properties b, c when property a is present",
            text: "<root>: must have properties b, c when property a is present",
          },
        ],
      },
      {
        title: "literal and nested containers with distinct conditions",
        schema: {
          type: "object",
          properties: {
            "room/one": { type: "object", dependentRequired: { literal: ["left", "right"] } },
            room: {
              type: "object",
              properties: {
                one: { type: "object", dependentRequired: { nested: ["left", "right"] } },
              },
            },
            "room~1one": { type: "object", dependentRequired: { tilde: ["left", "right"] } },
            "room%2Fone": { type: "object", dependentRequired: { percent: ["left", "right"] } },
          },
        },
        value: {
          "room/one": { literal: true, left: "present" },
          room: { one: { nested: true, right: "present" } },
          "room~1one": { tilde: true, left: "present" },
          "room%2Fone": { percent: true, right: "present" },
        },
        expectedErrors: [
          {
            path: "room.one",
            message: "must have properties left, right when property literal is present",
            text: "room.one: must have properties left, right when property literal is present",
          },
          {
            path: "room.one",
            message: "must have properties left, right when property nested is present",
            text: "room.one: must have properties left, right when property nested is present",
          },
          {
            path: "room~1one",
            message: "must have properties left, right when property tilde is present",
            text: "room~1one: must have properties left, right when property tilde is present",
          },
          {
            path: "room%2Fone",
            message: "must have properties left, right when property percent is present",
            text: "room%2Fone: must have properties left, right when property percent is present",
          },
        ],
      },
    ])(
      "preserves the dependency condition at $title",
      ({ title, schema, value, expectedErrors }) => {
        const result = expectValidationFailure({
          cacheKey: `schema-validator.test.condition.${title}`,
          schema,
          value,
        });

        expect(result.errors).toEqual(expectedErrors);
      },
    );
  });
});
