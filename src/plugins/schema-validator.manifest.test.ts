// Covers the manifest-schema boundary that keeps third-party schema failures out of the loader.
import { describe, expect, it } from "vitest";
import { validatePluginSchemaValue } from "./schema-validator.js";
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

  it("keeps returning results for a valid schema", () => {
    const result = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.valid",
      schema: { type: "object", properties: { a: { type: "string" } } },
      value: { a: "ok" },
    });

    expect(result).toEqual({ ok: true, value: { a: "ok" } });
  });

  it.each([
    { ref: "#/$defs/entry", key: "entry" },
    { ref: "#%2F$defs%2Fentry", key: "entry" },
    { ref: "#/$defs%2Fentry", key: "entry" },
    { ref: "https://example.test/config#%2F$defs%2Fentry", key: "entry" },
    { ref: "#%2F$defs%2Fa%7E1b", key: "a/b" },
    { ref: "#%2F$defs%2Fa%7E0b", key: "a~b" },
    { ref: "#%2F$defs%2Fpercent%252Fname", key: "percent%2Fname" },
  ])("validates and applies defaults through URI fragment $ref", ({ ref, key }) => {
    const value = {};
    const schema = {
      $id: "https://example.test/config",
      type: "object",
      $defs: { [key]: { type: "string", default: "ready" } },
      properties: { label: { $ref: ref } },
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

  it.each([
    "#%2F$defs%2Fmissing",
    "#%2F$defs%2Fentry%zz",
    "#/$defs/entry%zz",
    "https://outside.example/schema#%2F$defs%2Fentry",
  ])("reports missing or malformed URI fragment %s as an unusable schema", ($ref) => {
    expect(
      validatePluginSchemaValue({
        origin: "global",
        schema: { $defs: { entry: { type: "string" } }, $ref },
        value: "ready",
      }),
    ).toMatchObject({ ok: false, schemaError: true });
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
