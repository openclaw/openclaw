// Covers plugin config schema validation and diagnostics.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "./config-schema.js";

function expectSafeParseCases(
  safeParse: ((value: unknown) => unknown) | undefined,
  cases: ReadonlyArray<readonly [unknown, unknown]>,
) {
  if (safeParse === undefined) {
    throw new Error("expected config schema safeParse function");
  }
  expect(cases.map(([value]) => safeParse(value))).toEqual(cases.map(([, expected]) => expected));
}

function expectJsonSchema(
  result: ReturnType<typeof buildPluginConfigSchema>,
  expected: Record<string, unknown>,
) {
  expect(result.jsonSchema).toEqual(expected);
}

describe("buildPluginConfigSchema", () => {
  it("builds json schema in input mode", () => {
    const schema = z.strictObject({ enabled: z.boolean().default(true) });
    const result = buildPluginConfigSchema(schema);
    expectJsonSchema(result, {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean", default: true } },
    });
  });

  it("uses the host converter and preserves metadata, references and runtime transforms", () => {
    const policy = z.string().describe("Policy name").meta({
      id: "Plugin/Policy~v1",
      title: "Policy",
    });
    const schema = z.strictObject({
      settings: z.record(z.string(), z.boolean()).optional(),
      first: policy,
      second: policy,
      enabled: z.boolean().default(true),
      length: z
        .string()
        .transform((value) => value.length)
        .optional(),
    });
    vi.spyOn(schema, "toJSONSchema").mockImplementation(() => {
      throw new Error("schema-owned converter must not run");
    });

    const result = buildPluginConfigSchema(schema);

    expect(result.jsonSchema).toMatchObject({
      properties: {
        settings: { type: "object", additionalProperties: { type: "boolean" } },
        first: { $ref: "#/definitions/Plugin~1Policy~0v1" },
        second: { $ref: "#/definitions/Plugin~1Policy~0v1" },
        enabled: { type: "boolean", default: true },
        length: { type: "string" },
      },
      required: ["first", "second"],
      definitions: {
        "Plugin/Policy~v1": { type: "string", description: "Policy name", title: "Policy" },
      },
    });
    expect(result.jsonSchema).not.toHaveProperty("$schema");
    expect(result.jsonSchema).not.toHaveProperty("properties.settings.propertyNames");
    const input = { first: "read", second: "write", settings: { active: true }, length: "read" };
    expect(result.safeParse?.(input)).toEqual({
      success: true,
      data: { ...input, enabled: true, length: 4 },
    });
    expect(result.safeParse?.({ ...input, enabled: "yes" })).toMatchObject({
      success: false,
      error: { issues: [{ path: ["enabled"] }] },
    });
  });

  it("preserves permissive json schema and runtime parsing for zod v3 plugins", () => {
    const legacySchema = z3.object({ enabled: z3.boolean().default(true) }).strict();
    const result = buildPluginConfigSchema(
      legacySchema as unknown as Parameters<typeof buildPluginConfigSchema>[0],
    );
    expectJsonSchema(result, { type: "object", additionalProperties: true });
    expect(result.safeParse?.({})).toEqual({ success: true, data: { enabled: true } });
    expect(result.safeParse?.({ enabled: "yes" })).toMatchObject({
      success: false,
      error: { issues: [{ path: ["enabled"] }] },
    });
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

describe("buildJsonPluginConfigSchema", () => {
  it("validates direct JSON schemas without zod conversion", () => {
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: true },
        },
      },
      { cacheKey: "config-schema.test.json-plugin" },
    );

    expect(result.jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
    expect(result.safeParse?.({})).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(result.safeParse?.({ enabled: "yes" })).toEqual({
      success: false,
      error: { issues: [{ path: ["enabled"], message: "must be boolean" }] },
    });
  });

  it("keeps numeric-looking object keys outside array-index range as strings", () => {
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        required: ["100001"],
        properties: {
          "100001": { type: "boolean" },
        },
      },
      { cacheKey: "config-schema.test.large-numeric-key" },
    );

    expect(result.safeParse?.({})).toEqual({
      success: false,
      error: {
        issues: [{ path: ["100001"], message: "must have required property '100001'" }],
      },
    });
  });
});

describe("emptyPluginConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const schema = emptyPluginConfigSchema();
    expectSafeParseCases(schema.safeParse, [
      [undefined, { success: true, data: undefined }],
      [{}, { success: true, data: {} }],
      [
        { nope: true },
        { success: false, error: { issues: [{ path: [], message: "config must be empty" }] } },
      ],
    ] as const);
  });
});
