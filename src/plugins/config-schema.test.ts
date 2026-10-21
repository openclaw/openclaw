import { expect, it, vi } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "./config-schema.js";

it("uses the host converter and preserves metadata, references and runtime transforms", () => {
  const policy = z
    .string()
    .describe("Policy name")
    .meta({ id: "Plugin/Policy~v1", title: "Policy" });
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
  expect(result.jsonSchema).toEqual({ type: "object", additionalProperties: true });
  expect(result.safeParse?.({})).toEqual({ success: true, data: { enabled: true } });
  expect(result.safeParse?.({ enabled: "yes" })).toMatchObject({
    success: false,
    error: { issues: [{ path: ["enabled"] }] },
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

it("validates direct JSON schemas without zod conversion", () => {
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: { enabled: { type: "boolean", default: true } },
  };
  const result = buildJsonPluginConfigSchema(structuredClone(jsonSchema), {
    cacheKey: "config-schema.test.json-plugin",
  });
  expect(result.jsonSchema).toEqual(jsonSchema);
  expect(result.safeParse?.({})).toEqual({ success: true, data: { enabled: true } });
  expect(result.safeParse?.({ enabled: "yes" })).toEqual({
    success: false,
    error: { issues: [{ path: ["enabled"], message: "must be boolean" }] },
  });
});

it("emptyPluginConfigSchema accepts undefined and empty objects only", () => {
  const schema = emptyPluginConfigSchema();
  expect(schema.safeParse?.(undefined)).toEqual({ success: true, data: undefined });
  expect(schema.safeParse?.({})).toEqual({ success: true, data: {} });
  expect(schema.safeParse?.({ nope: true })).toEqual({
    success: false,
    error: { issues: [{ path: [], message: "config must be empty" }] },
  });
});
