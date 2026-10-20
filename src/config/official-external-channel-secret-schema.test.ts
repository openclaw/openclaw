import { expect, it } from "vitest";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { widenOfficialExternalChannelSecretSchema } from "./official-external-channel-secret-schema.js";
import { makeRegistry } from "./plugin-auto-enable.test-helpers.js";

const object = (properties: Record<string, unknown>) => ({ type: "object", properties });

it("widens Tencent QQBot root and account clientSecret fields to SecretRefs", () => {
  const schema = widenOfficialExternalChannelSecretSchema({
    channelId: "qqbot",
    schema: object({
      clientSecret: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: object({ clientSecret: { type: "string" } }),
      },
    }),
  });

  expect(schema).toHaveProperty("properties.clientSecret.anyOf.length", 2);
  expect(schema).toHaveProperty(
    "properties.accounts.additionalProperties.properties.clientSecret.anyOf.length",
    2,
  );
});

it("does not widen channels without a catalog secret contract", () => {
  const schema = object({ token: { type: "string" } });

  expect(widenOfficialExternalChannelSecretSchema({ channelId: "unknown", schema })).toBe(schema);
});

it("widens the installed Tencent manifest schema selected for channel validation", () => {
  const registry = makeRegistry([
    {
      id: "openclaw-qqbot",
      origin: "global",
      channels: ["qqbot"],
      channelConfigs: {
        qqbot: {
          schema: {
            ...object({ clientSecret: { type: "string" } }),
            additionalProperties: true,
          },
        },
      },
    },
  ]);

  const [metadata] = collectChannelSchemaMetadataWithOwnership(registry);
  expect(metadata?.configSchema).toHaveProperty("properties.clientSecret.anyOf.length", 2);
  expect(metadata?.configSchema?.allOf).toHaveLength(1);
});

it("fails closed on QQBot configs that have not run the Tencent 2.0 migration", () => {
  const schema = widenOfficialExternalChannelSecretSchema({
    channelId: "qqbot",
    schema: { type: "object", additionalProperties: true },
  });
  if (!schema) {
    throw new Error("expected QQBot host schema");
  }
  const validate = (value: unknown) =>
    validateJsonSchemaValue({
      cacheKey: `qqbot-host-schema-${JSON.stringify(value)}`,
      schema,
      value,
    }).ok;

  expect(validate({})).toBe(false);
  expect(validate({ allowFrom: ["*"] })).toBe(false);
  expect(validate({ allowFrom: ["user123"] })).toBe(false);
  expect(validate({ defaultAccount: "ops", allowFrom: ["OWNER"] })).toBe(false);
  const account = (id: string) => ({
    allowFrom: ["openclaw:approval-disabled"],
    accounts: { [id]: { allowFrom: ["OWNER"] } },
  });
  expect(validate(account("default"))).toBe(false);
  expect(validate(account("ops"))).toBe(true);
});
