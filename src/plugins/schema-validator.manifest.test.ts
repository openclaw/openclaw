import { Format } from "typebox/format";
import { expect, it } from "vitest";
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
it("keeps cached checks and error details on the same plugin format semantics", () => {
  const formats = Format.Entries();
  const schema = objectSchema(
    {
      endpoint: { type: "string", format: "uri" },
      contact: { type: "string", format: "email" },
      token: { type: "string", format: "uuid" },
    },
    { required: ["endpoint", "contact", "token"] },
  );
  const input = {
    schema,
    value: { endpoint: "https://example.com", contact: "not an email", token: "not a uuid" },
  };
  expect(validateJsonSchemaValue(input)).toEqual({ ok: true, value: input.value });
  expect(Format.Entries()).toEqual(formats);
  const result = validateJsonSchemaValue({
    ...input,
    value: { ...input.value, endpoint: "https://" },
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
  expect(validateJsonSchemaValue(input)).toEqual({ ok: true, value: input.value });
  expect(Format.Entries()).toEqual(formats);
  expect(Format.Get("email")?.("not an email")).toBe(false);
  expect(Format.Get("uuid")?.("not a uuid")).toBe(false);
});
