// Config schema tests cover channel plugin config schema validation and defaults.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ChannelGroupEntrySchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildJsonChannelConfigSchema,
  buildMultiAccountChannelSchema,
  emptyChannelConfigSchema,
} from "./config-schema.js";

describe("channel config composition", () => {
  it("builds canonical and channel-extended group entries", () => {
    expect(
      ChannelGroupEntrySchema.safeParse({
        requireMention: true,
        tools: { allow: ["read"] },
        toolsBySender: { U1: { deny: ["write"] } },
        skills: ["search"],
        enabled: true,
        allowFrom: ["U1", 2],
        systemPrompt: "Be concise",
      }).success,
    ).toBe(true);
    expect(
      buildGroupEntrySchema({ topic: z.boolean().optional() }).safeParse({ topic: true }).success,
    ).toBe(true);
    expect(ChannelGroupEntrySchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("applies one shared refinement to root and account entries", () => {
    const base = z.object({
      policy: z.enum(["closed", "open"]).optional(),
      allow: z.boolean().optional(),
    });
    const schema = buildMultiAccountChannelSchema(base, {
      optionalAccount: true,
      refine: (value, ctx) => {
        if (value.policy === "open" && !value.allow) {
          ctx.addIssue({ code: "custom", path: ["allow"], message: "open requires allow" });
        }
      },
    });

    expect(schema.safeParse({ policy: "open" }).success).toBe(false);
    expect(schema.safeParse({ accounts: { work: { policy: "open" } } }).success).toBe(false);
    expect(
      schema.safeParse({ policy: "open", allow: true, accounts: { work: undefined } }).success,
    ).toBe(true);
  });

  it("awaits an asynchronous shared refinement for root and account entries", async () => {
    const base = z.object({ enabled: z.boolean().optional() });
    const schema = buildMultiAccountChannelSchema(base, {
      refine: async (value, ctx) => {
        expect(ctx.value).toBe(value);
        await Promise.resolve();
        if (value.enabled) {
          ctx.addIssue({ code: "custom", path: ["enabled"], message: "disabled required" });
        }
      },
    });

    await expect(schema.safeParseAsync({ enabled: true })).resolves.toMatchObject({
      success: false,
    });
    await expect(
      schema.safeParseAsync({ accounts: { work: { enabled: true } } }),
    ).resolves.toMatchObject({ success: false });
  });
});

describe("buildChannelConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.object({ enabled: z.boolean().default(true) });
    const result = buildChannelConfigSchema(schema);
    expect(result.schema).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          default: true,
        },
      },
      required: ["enabled"],
      additionalProperties: false,
    });
  });

  it("falls back when toJSONSchema is missing (zod v3 plugin compatibility)", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildChannelConfigSchema>[0];
    const result = buildChannelConfigSchema(legacySchema);
    expect(result.schema).toEqual({ type: "object", additionalProperties: true });
  });

  it("passes draft-07 compatibility options to toJSONSchema", () => {
    const toJSONSchema = vi.fn(() => ({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildChannelConfigSchema>[0];

    const result = buildChannelConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      unrepresentable: "any",
    });
    expect(result.schema).toEqual({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    });
  });

  it("can describe accepted transform inputs instead of unrepresentable outputs", () => {
    const result = buildChannelConfigSchema(
      z.object({
        policy: z.union([
          z.enum(["open", "disabled"]),
          z.literal("legacy").transform(() => "open" as const),
        ]),
      }),
      { jsonSchemaMode: "input" },
    );

    expect(result.schema).toMatchObject({
      properties: {
        policy: {
          anyOf: [
            { type: "string", enum: ["open", "disabled"] },
            { type: "string", const: "legacy" },
          ],
        },
      },
    });
    expect(result.runtime?.safeParse({ policy: "legacy" })).toEqual({
      success: true,
      data: { policy: "open" },
    });
  });

  it("passes through ui hints and exposes a runtime parser", () => {
    const result = buildChannelConfigSchema(z.object({ enabled: z.boolean().default(true) }), {
      uiHints: { enabled: { label: "Enabled" } },
    });

    expect(result.uiHints).toEqual({ enabled: { label: "Enabled" } });
    expect(result.runtime?.safeParse({})).toEqual({
      success: true,
      data: { enabled: true },
    });
  });
});

describe("buildJsonChannelConfigSchema", () => {
  it("validates direct JSON schemas without zod conversion", () => {
    const result = buildJsonChannelConfigSchema(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: true },
        },
      },
      { cacheKey: "config-schema.test.json-channel" },
    );

    expect(result.schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
    expect(result.runtime?.safeParse({})).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(result.runtime?.safeParse({ enabled: "yes" })).toEqual({
      success: false,
      issues: [{ path: ["enabled"], message: "must be boolean" }],
    });
  });

  it("keeps numeric-looking object keys outside array-index range as strings", () => {
    const result = buildJsonChannelConfigSchema(
      {
        type: "object",
        required: ["100001"],
        properties: {
          "100001": { type: "boolean" },
        },
      },
      { cacheKey: "config-schema.test.large-numeric-key-channel" },
    );

    expect(result.runtime?.safeParse({})).toEqual({
      success: false,
      issues: [{ path: ["100001"], message: "must have required property '100001'" }],
    });
  });
});

describe("emptyChannelConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const result = emptyChannelConfigSchema();

    expect(result.runtime?.safeParse(undefined)).toEqual({
      success: true,
      data: undefined,
    });
    expect(result.runtime?.safeParse({})).toEqual({
      success: true,
      data: {},
    });
    expect(result.runtime?.safeParse({ enabled: true })).toEqual({
      success: false,
      issues: [{ path: [], message: "config must be empty" }],
    });
  });
});
