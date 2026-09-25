import { Format } from "typebox/format";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

describe("plugin schema format semantics", () => {
  it.each([
    { value: "https://api.telegram.org", ok: true },
    { value: "not a uri", ok: false },
    { value: "https://", ok: false },
  ])("validates URI $value (allowed=$ok)", ({ value, ok }) => {
    const result = validateJsonSchemaValue({
      cacheKey: `schema-validator.test.uri.${value}`,
      schema: {
        type: "object",
        properties: { apiRoot: { type: "string", format: "uri" } },
        required: ["apiRoot"],
      },
      value: { apiRoot: value },
    });
    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: "apiRoot",
          message: expect.stringContaining("must match format"),
        }),
      ]);
    }
  });

  it("treats non-uri string formats as annotations", () => {
    const value = { contact: "not an email", token: "not a uuid" };
    expect(
      validateJsonSchemaValue({
        cacheKey: "schema-validator.test.format.email.annotation",
        schema: {
          type: "object",
          properties: {
            contact: { type: "string", format: "email" },
            token: { type: "string", format: "uuid" },
          },
          required: ["contact", "token"],
        },
        value,
      }),
    ).toEqual({ ok: true, value });
  });

  it("does not weaken the global TypeBox format registry", () => {
    expect(Format.Get("email")?.("not an email")).toBe(false);
    expect(Format.Get("uuid")?.("not a uuid")).toBe(false);
  });

  it("keeps cached checks and error details on the same plugin format semantics", () => {
    const formats = Format.Entries();
    const schema = {
      type: "object",
      properties: {
        endpoint: { type: "string", format: "uri" },
        contact: { type: "string", format: "email" },
      },
      required: ["endpoint", "contact"],
    };
    const input = {
      cacheKey: "schema-validator.test.cached-formats",
      schema,
      value: { endpoint: "https://example.com", contact: "not an email" },
    };
    expect(validateJsonSchemaValue(input)).toEqual({ ok: true, value: input.value });
    expect(Format.Entries()).toEqual(formats);
    const result = validateJsonSchemaValue({
      ...input,
      value: { endpoint: "https://", contact: "not an email" },
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
  });
});
