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
  it("preserves exact value paths despite ambiguous display paths", () => {
    const result = expectValidationFailure({
      schema: {
        type: "object",
        properties: {
          "dot.name": { type: "number" },
          dot: { type: "object", properties: { name: { type: "number" } } },
          "slash/name": { type: "number" },
          "tilde~1name": { type: "number" },
          "": { type: "number" },
          "<root>": { type: "number" },
          items: { type: "array", items: { type: "number" } },
        },
      },
      value: {
        "dot.name": "invalid",
        dot: { name: "invalid" },
        "slash/name": "invalid",
        "tilde~1name": "invalid",
        "": "invalid",
        "<root>": "invalid",
        items: ["invalid"],
      },
    });

    expect(result.errors.map(({ valuePath }) => valuePath)).toEqual([
      ["dot.name"],
      ["dot", "name"],
      ["slash/name"],
      ["tilde~1name"],
      [""],
      ["<root>"],
      ["items", "0"],
    ]);
    expect(
      expectValidationFailure({ schema: { type: "number" }, value: "invalid" }).errors,
    ).toMatchObject([{ path: "<root>", valuePath: [] }]);
  });

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
          valuePath: ["settings", "endpoint"],
          message: "must have required property 'endpoint'",
          text: "settings.endpoint: must have required property 'endpoint'",
        },
        {
          path: "settings.token",
          valuePath: ["settings", "token"],
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
          valuePath: ["endpoint"],
          message: "must have required property 'endpoint'",
          text: "endpoint: must have required property 'endpoint'",
        },
        {
          path: "evil\nkey\t\x1b[31mred\x1b[0m",
          valuePath: ["evil\nkey\t\x1b[31mred\x1b[0m"],
          message: "must have required property 'evil\nkey\t\x1b[31mred\x1b[0m'",
          text: "evil\\nkey\\tred: must have required property 'evil\\nkey\\tred'",
        },
      ],
    },
    {
      title: "literal missing property names",
      schema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            required: ["dot.name", "slash/name", "tilde~1name", "", "<root>"],
          },
        },
      },
      value: { settings: {} },
      expectedErrors: [
        {
          path: "settings.dot.name",
          valuePath: ["settings", "dot.name"],
          message: "must have required property 'dot.name'",
          text: "settings.dot.name: must have required property 'dot.name'",
        },
        {
          path: "settings.slash/name",
          valuePath: ["settings", "slash/name"],
          message: "must have required property 'slash/name'",
          text: "settings.slash/name: must have required property 'slash/name'",
        },
        {
          path: "settings.tilde~1name",
          valuePath: ["settings", "tilde~1name"],
          message: "must have required property 'tilde~1name'",
          text: "settings.tilde~1name: must have required property 'tilde~1name'",
        },
        {
          path: "settings",
          valuePath: ["settings", ""],
          message: "must have required property ''",
          text: "settings: must have required property ''",
        },
        {
          path: "settings.<root>",
          valuePath: ["settings", "<root>"],
          message: "must have required property '<root>'",
          text: "settings.<root>: must have required property '<root>'",
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
            valuePath: [],
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
            valuePath: [],
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
            valuePath: ["room/one"],
            message: "must have properties left, right when property literal is present",
            text: "room.one: must have properties left, right when property literal is present",
          },
          {
            path: "room.one",
            valuePath: ["room", "one"],
            message: "must have properties left, right when property nested is present",
            text: "room.one: must have properties left, right when property nested is present",
          },
          {
            path: "room~1one",
            valuePath: ["room~1one"],
            message: "must have properties left, right when property tilde is present",
            text: "room~1one: must have properties left, right when property tilde is present",
          },
          {
            path: "room%2Fone",
            valuePath: ["room%2Fone"],
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
