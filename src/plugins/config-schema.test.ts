import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildPluginConfigSchema, emptyPluginConfigSchema } from "./config-schema.js";

describe("buildPluginConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.strictObject({ enabled: z.boolean().default(true) });
    const result = buildPluginConfigSchema(schema);
    expect(result.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean", default: true } },
    });
  });

  it("uses input mode and strips helper-only draft metadata", () => {
    const toJSONSchema = vi.fn(() => ({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      propertyNames: { type: "string" },
      required: [],
      properties: {
        enabled: { type: "boolean", default: true },
      },
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildPluginConfigSchema>[0];

    const result = buildPluginConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      io: "input",
      unrepresentable: "any",
    });
    expect(result.jsonSchema).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
  });

  it("falls back when toJSONSchema is missing", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildPluginConfigSchema>[0];
    const result = buildPluginConfigSchema(legacySchema);
    expect(result.jsonSchema).toEqual({ type: "object", additionalProperties: true });
  });

  it("uses zod runtime parsing by default", () => {
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().default(true) }));
    expect(result.safeParse?.({})).toEqual({
      success: true,
      data: { enabled: true },
    });
  });

  it("allows custom safeParse overrides", () => {
    const safeParse = vi.fn(() => ({ success: true as const, data: { normalized: true } }));
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().optional() }), {
      safeParse,
    });

    expect(result.safeParse?.({ enabled: false })).toEqual({
      success: true,
      data: { normalized: true },
    });
    expect(safeParse).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("emptyPluginConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const schema = emptyPluginConfigSchema();
    expect(schema.safeParse?.(undefined)).toEqual({ success: true, data: undefined });
    expect(schema.safeParse?.({})).toEqual({ success: true, data: {} });
    expect(schema.safeParse?.({ nope: true })).toEqual({
      success: false,
      error: { issues: [{ path: [], message: "config must be empty" }] },
    });
  });
});
