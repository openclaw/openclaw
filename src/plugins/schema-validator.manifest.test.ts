// Covers the manifest-schema boundary that keeps third-party schema failures out of the loader.
import { Format } from "typebox/format";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue, validatePluginSchemaValue } from "./schema-validator.js";

describe("validatePluginSchemaValue", () => {
  it("strips terminal control characters a manifest embedded in the thrown text", () => {
    const escape = String.fromCharCode(27);
    const result = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.ansi-pattern",
      schema: {
        type: "object",
        properties: { a: { type: "string", pattern: `${escape}[31m(unclosed` } },
      },
      value: { a: "x" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors[0]?.text).not.toContain(escape);
  });

  it("validates and applies defaults through an encoded URI fragment", () => {
    const value = {};
    const schema = {
      $id: "https://example.test/config",
      type: "object",
      $defs: { entry: { type: "string", default: "ready" } },
      properties: { label: { $ref: "https://example.test/config#%2F$defs%2Fentry" } },
      required: ["label"],
    };

    expect(
      validatePluginSchemaValue({ origin: "global", schema, value, applyDefaults: true }),
    ).toEqual({ ok: true, value: { label: "ready" } });
    expect(value).toEqual({});
    expect(
      validatePluginSchemaValue({ origin: "global", schema, value: { label: 42 } }),
    ).toMatchObject({ ok: false, schemaError: false });
  });

  it("selects the nested default for encoded separators without replacing supplied values", () => {
    const schema = {
      type: "object",
      $defs: {
        "a/b": { type: "string", default: "literal" },
        a: { b: { type: "string", default: "nested" } },
      },
      properties: { label: { $ref: "#/$defs/a%2Fb" } },
      required: ["label"],
    };
    expect(
      validatePluginSchemaValue({ origin: "global", schema, value: {}, applyDefaults: true }),
    ).toEqual({ ok: true, value: { label: "nested" } });
    expect(
      validatePluginSchemaValue({
        origin: "global",
        schema,
        value: { label: "literal" },
        applyDefaults: true,
      }),
    ).toEqual({ ok: true, value: { label: "literal" } });
  });

  it("flags schemaError only when the schema itself is unusable, not on ordinary value failures", () => {
    const malformedSchema = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.schema-error-flag",
      schema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
      value: {},
    });
    expect(malformedSchema).toMatchObject({ ok: false, schemaError: true });
    expect(malformedSchema.ok ? "" : malformedSchema.errors[0]?.text).toContain("invalid schema");

    const wellFormedSchemaRejectingValue = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.value-error-flag",
      schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
      value: {},
    });
    expect(wellFormedSchemaRejectingValue).toMatchObject({ ok: false, schemaError: false });
  });
});

describe("plugin schema format semantics", () => {
  it("keeps cached checks and error details on the same plugin format semantics", () => {
    const formats = Format.Entries();
    const schema = {
      type: "object",
      properties: {
        endpoint: { type: "string", format: "uri" },
        contact: { type: "string", format: "email" },
        token: { type: "string", format: "uuid" },
      },
      required: ["endpoint", "contact", "token"],
    };
    const input = {
      cacheKey: "schema-validator.test.cached-formats",
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
});
