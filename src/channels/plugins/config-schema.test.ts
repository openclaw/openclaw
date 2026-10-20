import { expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import {
  ChannelGroupEntrySchema,
  buildCatchallMultiAccountChannelSchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildJsonChannelConfigSchema,
  buildMultiAccountChannelSchema,
  emptyChannelConfigSchema,
} from "./config-schema.js";
import type { ChannelConfigSchema } from "./types.config.js";

function expectParsed(result: ChannelConfigSchema, input: unknown, data: unknown) {
  expect(result.runtime?.safeParse(input)).toEqual({ success: true, data });
}

it("builds canonical and channel-extended group entries", () => {
  const extended = buildGroupEntrySchema({ topic: z.boolean().optional() });
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
  expect(extended.safeParse({ topic: true }).success).toBe(true);
  expectTypeOf<z.infer<typeof extended>["tools"]>().toEqualTypeOf<
    z.infer<typeof ChannelGroupEntrySchema>["tools"]
  >();
  expectTypeOf<z.infer<typeof extended>["topic"]>().toEqualTypeOf<boolean | undefined>();
  expect(ChannelGroupEntrySchema.safeParse({ unknown: true }).success).toBe(false);
});

it("can omit canonical group leaves without duplicating the remaining shape", () => {
  const schema = buildGroupEntrySchema({ topic: z.boolean().optional() }, { omit: ["skills"] });

  expect(schema.safeParse({ topic: true, allowFrom: ["U1"] }).success).toBe(true);
  expect(schema.safeParse({ skills: ["search"] }).success).toBe(false);
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
  expectTypeOf<z.infer<typeof schema>["policy"]>().toEqualTypeOf<"closed" | "open" | undefined>();
});

it("preserves root and account transforms and catchalls with catchall accounts", () => {
  const account = z
    .object({ port: z.string().transform((value) => Number(value)) })
    .catchall(z.string());
  const schema = buildCatchallMultiAccountChannelSchema(account);
  const rootOnlyInput: z.input<typeof schema> = { port: "80", custom: "root" };

  type AccountInput = NonNullable<z.input<typeof schema>["accounts"]>[string];
  type AccountOutput = NonNullable<z.output<typeof schema>["accounts"]>[string];
  expectTypeOf<AccountInput["port"]>().toEqualTypeOf<string>();
  expectTypeOf<AccountOutput["port"]>().toEqualTypeOf<number>();
  expectTypeOf<AccountInput["custom"]>().toEqualTypeOf<string>();
  expectTypeOf<AccountOutput["custom"]>().toEqualTypeOf<string>();
  expectTypeOf<z.input<typeof schema>["custom"]>().toEqualTypeOf<string>();
  expectTypeOf<z.output<typeof schema>["custom"]>().toEqualTypeOf<string>();
  const rootOutput = { port: 80, custom: "root" };
  expect(schema.parse(rootOnlyInput)).toEqual(rootOutput);
  expect(
    schema.parse({
      ...rootOnlyInput,
      defaultAccount: "work",
      accounts: { work: { port: "443", custom: "account" } },
    }),
  ).toEqual({
    ...rootOutput,
    defaultAccount: "work",
    accounts: { work: { port: 443, custom: "account" } },
  });
});
it("converts SDK schemas with the host while retaining metadata, references and defaults", () => {
  const policy = z.string().describe("Policy name").meta({
    id: "Channel/Policy~v1",
    title: "Policy",
  });
  const schema = z.object({
    group: buildGroupEntrySchema(),
    first: policy,
    second: policy,
    enabled: z.boolean().default(true),
  });
  vi.spyOn(schema, "toJSONSchema").mockImplementation(() => {
    throw new Error("schema-owned converter must not run");
  });

  const required = ["group", "first", "second"];
  for (const jsonSchemaMode of ["input", "output"] as const) {
    const result = buildChannelConfigSchema(schema, {
      jsonSchemaMode,
      uiHints: { enabled: { label: "Enabled" } },
    });
    expect(result.uiHints).toEqual({ enabled: { label: "Enabled" } });
    expect(result.schema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      required: jsonSchemaMode === "output" ? [...required, "enabled"] : required,
      properties: {
        group: {
          properties: {
            toolsBySender: {
              type: "object",
              additionalProperties: { properties: { allow: { type: "array" } } },
            },
          },
        },
        first: { $ref: "#/definitions/Channel~1Policy~0v1" },
        second: { $ref: "#/definitions/Channel~1Policy~0v1" },
        enabled: { type: "boolean", default: true },
      },
      definitions: {
        "Channel/Policy~v1": { type: "string", description: "Policy name", title: "Policy" },
      },
    });
    const input = {
      group: { toolsBySender: { sender: { allow: ["read"] } } },
      first: "read",
      second: "write",
    };
    expectParsed(result, input, { ...input, enabled: true });
    expect(result.runtime?.safeParse({ ...input, enabled: "yes" })).toMatchObject({
      success: false,
      issues: [{ path: ["enabled"] }],
    });
  }
});

it("can describe accepted transform inputs instead of unrepresentable outputs", () => {
  const policy = z.union([
    z.enum(["open", "disabled"]),
    z.literal("legacy").transform(() => "open" as const),
  ]);
  const result = buildChannelConfigSchema(z.object({ policy }), { jsonSchemaMode: "input" });

  expect(result.schema.properties).toMatchObject({
    policy: {
      anyOf: [
        { type: "string", enum: ["open", "disabled"] },
        { type: "string", const: "legacy" },
      ],
    },
  });
  expectParsed(result, { policy: "legacy" }, { policy: "open" });
});
const enabledJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { enabled: { type: "boolean", default: true } },
};
it("preserves zod v3 schemas, validates values and applies defaults", () => {
  const schema = z3.object({ enabled: z3.boolean().default(true) }).strict();
  const result = buildChannelConfigSchema(
    schema as unknown as Parameters<typeof buildChannelConfigSchema>[0],
  );
  expect(result.schema).toEqual({ type: "object", additionalProperties: true });
  expectParsed(result, {}, { enabled: true });
  expect(result.runtime?.safeParse({ enabled: "yes" })).toMatchObject({
    success: false,
    issues: [{ path: ["enabled"] }],
  });
});
it("preserves JSON schemas, validates values and applies defaults", () => {
  const result = buildJsonChannelConfigSchema(structuredClone(enabledJsonSchema), {
    cacheKey: "config-schema.test.json-channel",
  });
  expect(result.schema).toEqual(enabledJsonSchema);
  expectParsed(result, {}, { enabled: true });
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
it.each([
  [undefined, { success: true, data: undefined }],
  [{}, { success: true, data: {} }],
  [{ enabled: true }, { success: false, issues: [{ path: [], message: "config must be empty" }] }],
])("accepts only undefined or empty objects (%j)", (input, expected) => {
  expect(emptyChannelConfigSchema().runtime?.safeParse(input)).toEqual(expected);
});
