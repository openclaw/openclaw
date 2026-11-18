import { Format } from "typebox/format";
import { Settings } from "typebox/system";
import { expect, it, vi } from "vitest";
import * as schemaDefaults from "../shared/json-schema-defaults.js";
import {
  validateJsonSchemaValue,
  validatePluginSchemaValue,
  type JsonSchemaValue,
} from "./schema-validator.js";

function check(schema: JsonSchemaValue, value: unknown = {}, applyDefaults = false) {
  return validatePluginSchemaValue({ origin: "global", schema, value, applyDefaults });
}
const schemaId = "https://example.test/config";
const textDefault = (value: string) => ({ type: "string", default: value });
function objectSchema(props: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: "object", properties: props, ...extra };
}

it("does not reuse evaluated properties between cached nonaccelerated checks", () => {
  const useAcceleration = Settings.Get().useAcceleration;
  Settings.Set({ useAcceleration: false });
  try {
    const schema = {
      type: "object",
      anyOf: [{ properties: { a: { type: "number" } } }, { properties: { b: { type: "number" } } }],
      unevaluatedProperties: false,
    };
    expect(check(schema, { a: 1 })).toMatchObject({ ok: true });
    expect(check(schema, { a: "bad" })).toMatchObject({ ok: false, schemaError: false });
    expect(check(schema, { b: 2 })).toMatchObject({ ok: true });
    expect(check(schema, { b: "bad" })).toMatchObject({ ok: false, schemaError: false });
  } finally {
    Settings.Set({ useAcceleration });
  }
});

it("strips terminal control characters a manifest embedded in the thrown text", () => {
  const escape = String.fromCharCode(27);
  const result = check(objectSchema({ a: { type: "string", pattern: `${escape}[31m(unclosed` } }), {
    a: "x",
  });

  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.errors[0]?.text).not.toContain(escape);
});

it.each([
  [`${schemaId}#%2F$defs%2Fentry`, { entry: textDefault("ready") }, "ready"],
  ["#/$defs/a%2Fb", { "a/b": textDefault("literal"), a: { b: textDefault("nested") } }, "nested"],
] as const)("resolves defaults through %s without overwriting input", (ref, $defs, label) => {
  const schema = objectSchema(
    { label: { $ref: ref } },
    { $id: schemaId, $defs, required: ["label"] },
  );
  const value = {};
  expect(check(schema, value, true)).toEqual({ ok: true, value: { label } });
  expect(value).toEqual({});
  expect(check(schema, { label: "literal" }, true)).toEqual({
    ok: true,
    value: { label: "literal" },
  });
  expect(check(schema, { label: 42 })).toMatchObject({ ok: false, schemaError: false });
});

it("flags schemaError only when the schema itself is unusable, not on ordinary value failures", () => {
  const malformedSchema = check(objectSchema({ mode: { $ref: "#/$defs/Mode" } }));
  expect(malformedSchema).toMatchObject({ ok: false, schemaError: true });
  expect(malformedSchema.ok ? "" : malformedSchema.errors[0]?.text).toContain("invalid schema");

  expect(check({ type: "object", required: ["token"] })).toMatchObject({
    ok: false,
    schemaError: false,
  });
});
it.each([true, false])(
  "keeps plugin format checks local with acceleration %s",
  (useAcceleration) => {
    const previousAcceleration = Settings.Get().useAcceleration;
    const formats = Format.Entries();
    Format.Set("plugin-custom", (value) => value === "accepted");
    const expectedFormats = Format.Entries();
    Settings.Set({ useAcceleration });
    try {
      const schema = objectSchema(
        {
          endpoint: { type: "string", format: "uri" },
          contact: { type: "string", format: "email" },
          token: { type: "string", format: "uuid" },
          custom: { type: "string", format: "plugin-custom" },
        },
        { required: ["endpoint", "contact", "token"], title: `formats-${useAcceleration}` },
      );
      const observedEmailChecks: boolean[] = [];
      const value = {
        get endpoint() {
          // A caller's validation can run while the plugin reads a property.
          observedEmailChecks.push(Format.Get("email")?.("not an email") ?? false);
          return "https://example.com";
        },
        contact: "not an email",
        token: "not a uuid",
        custom: "accepted",
      };
      const input = { schema, value };
      expect(validateJsonSchemaValue(input)).toEqual({ ok: true, value });
      expect(observedEmailChecks.length).toBeGreaterThan(0);
      expect(observedEmailChecks.every((valid) => !valid)).toBe(true);
      expect(Format.Entries()).toEqual(expectedFormats);
      const result = validateJsonSchemaValue({
        ...input,
        value: { ...value, endpoint: "https://" },
      });
      expect(result).toEqual({
        ok: false,
        errors: [
          expect.objectContaining({
            path: "endpoint",
            message: expect.stringContaining("must match format"),
          }),
        ],
      });
      expect(
        validateJsonSchemaValue({ ...input, value: { ...value, custom: "rejected" } }),
      ).toMatchObject({
        ok: false,
        errors: [
          expect.objectContaining({ path: "custom", message: 'must match format "plugin-custom"' }),
        ],
      });
      expect(validateJsonSchemaValue(input)).toEqual({ ok: true, value });
      expect(Format.Entries()).toEqual(expectedFormats);
      expect(Format.Get("email")?.("not an email")).toBe(false);
      expect(Format.Get("uuid")?.("not a uuid")).toBe(false);
    } finally {
      Settings.Set({ useAcceleration: previousAcceleration });
      Format.Clear();
      for (const [name, formatCheck] of formats) {
        Format.Set(name, formatCheck);
      }
    }
  },
);

it("uses the same local format policy when choosing conditional defaults", () => {
  const schema = objectSchema(
    {
      endpoint: { type: "string" },
      contact: { type: "string" },
      mode: { type: ["string", "null"], default: "configured" },
    },
    {
      allOf: [
        {
          if: { properties: { contact: { format: "email" } } },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
          then: { properties: { contactKind: { default: "annotation" } } },
        },
        {
          if: { properties: { endpoint: { format: "uri" } } },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
          then: { properties: { endpointKind: { default: "absolute" } } },
          else: { properties: { endpointKind: { default: "relative" } } },
        },
      ],
    },
  );
  expect(check(schema, { contact: "not an email", endpoint: "/relative" }, true)).toEqual({
    ok: true,
    value: {
      contact: "not an email",
      endpoint: "/relative",
      contactKind: "annotation",
      endpointKind: "relative",
      mode: "configured",
    },
  });
});

it("admits equivalent immutable schemas once while detecting mutable descendants", () => {
  const readSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({ action: Object.freeze({ const: "read" }) }),
  });
  const sameReadSchema = Object.freeze({
    type: "object",
    properties: Object.freeze({ action: Object.freeze({ const: "read" }) }),
  });
  const mutableSchema = Object.freeze({
    type: "object",
    properties: { value: { type: "string" } },
  });
  const stringify = vi.spyOn(JSON, "stringify");
  const admitSchema = vi.spyOn(schemaDefaults, "findJsonSchemaShapeError");
  try {
    for (const type of ["string", "number"]) {
      expect(validateJsonSchemaValue({ schema: readSchema, value: { action: "read" } }).ok).toBe(
        true,
      );
      mutableSchema.properties.value.type = type;
      expect(validateJsonSchemaValue({ schema: mutableSchema, value: { value: "text" } }).ok).toBe(
        type === "string",
      );
      expect(
        validateJsonSchemaValue({ schema: sameReadSchema, value: { action: "read" } }).ok,
      ).toBe(true);
    }
    for (const work of [stringify, admitSchema]) {
      expect(
        [readSchema, sameReadSchema, mutableSchema].map(
          (schema) => work.mock.calls.filter(([value]) => value === schema).length,
        ),
      ).toEqual([1, 1, 2]);
    }

    for (let index = 0; index < 2; index++) {
      expect(
        validateJsonSchemaValue({ schema: readSchema, value: { action: "read" }, cache: false }).ok,
      ).toBe(true);
    }
    expect(stringify.mock.calls.filter(([value]) => value === readSchema)).toHaveLength(3);
    expect(admitSchema.mock.calls.filter(([value]) => value === readSchema)).toHaveLength(3);
  } finally {
    admitSchema.mockRestore();
    stringify.mockRestore();
  }
});
