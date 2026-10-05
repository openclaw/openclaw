import { Format } from "typebox/format";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

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
