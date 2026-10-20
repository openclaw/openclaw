import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

function diagnostic(
  path: string,
  valuePath: string[],
  message: string,
  text = `${path}: ${message}`,
) {
  return { path, valuePath, message, text };
}

function required(path: string, valuePath: string[], name: string) {
  return diagnostic(path, valuePath, `must have required property '${name}'`);
}

function dependency(path: string, valuePath: string[], trigger: string, names = "left, right") {
  return diagnostic(
    path,
    valuePath,
    `must have properties ${names} when property ${trigger} is present`,
  );
}

function requiredSchema(names: string[], container?: string) {
  const schema = { type: "object", required: names };
  return container ? { type: "object", properties: { [container]: schema } } : schema;
}

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
      schema: requiredSchema(["endpoint", "token"], "settings"),
      value: { settings: {} },
      expectedErrors: [
        required("settings.endpoint", ["settings", "endpoint"], "endpoint"),
        required("settings.token", ["settings", "token"], "token"),
      ],
    },
    {
      title: "terminal controls in a later field",
      schema: requiredSchema(["endpoint", "evil\nkey\t\x1b[31mred\x1b[0m"]),
      value: {},
      expectedErrors: [
        required("endpoint", ["endpoint"], "endpoint"),
        diagnostic(
          "evil\nkey\t\x1b[31mred\x1b[0m",
          ["evil\nkey\t\x1b[31mred\x1b[0m"],
          "must have required property 'evil\nkey\t\x1b[31mred\x1b[0m'",
          "evil\\nkey\\tred: must have required property 'evil\\nkey\\tred'",
        ),
      ],
    },
    {
      title: "literal missing property names",
      schema: requiredSchema(["dot.name", "slash/name", "tilde~1name", "", "<root>"], "settings"),
      value: { settings: {} },
      expectedErrors: [
        required("settings.dot.name", ["settings", "dot.name"], "dot.name"),
        required("settings.slash/name", ["settings", "slash/name"], "slash/name"),
        required("settings.tilde~1name", ["settings", "tilde~1name"], "tilde~1name"),
        required("settings", ["settings", ""], ""),
        required("settings.<root>", ["settings", "<root>"], "<root>"),
      ],
    },
  ])("reports complete required diagnostics for $title", ({ schema, value, expectedErrors }) => {
    const result = expectValidationFailure({
      schema,
      value,
    });

    expect(result.errors).toEqual(expectedErrors);
  });

  it.each([
    {
      title: "all dependencies missing in one condition",
      schema: { type: "object", dependentRequired: { a: ["b", "c"] } },
      value: { a: true },
      expectedErrors: [dependency("<root>", [], "a", "b, c")],
    },
    {
      title: "root with the first dependency already present",
      schema: { type: "object", dependencies: { a: ["b", "c"] } },
      value: { a: true, b: "present" },
      expectedErrors: [dependency("<root>", [], "a", "b, c")],
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
        dependency("room.one", ["room/one"], "literal"),
        dependency("room.one", ["room", "one"], "nested"),
        dependency("room~1one", ["room~1one"], "tilde"),
        dependency("room%2Fone", ["room%2Fone"], "percent"),
      ],
    },
  ])("preserves the dependency condition at $title", ({ schema, value, expectedErrors }) => {
    const result = expectValidationFailure({
      schema,
      value,
    });

    expect(result.errors).toEqual(expectedErrors);
  });
});
