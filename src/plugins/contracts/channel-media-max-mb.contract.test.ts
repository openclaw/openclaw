// Verifies every bundled channel accepts the documented mediaMaxMb override.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/**
 * A closed schema without the key refuses the whole config. Composed schemas
 * must be walked: a union accepts when any alternative accepts, while allOf is
 * an intersection where one closed component still refuses the key.
 */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.every((branch) => rejectsKey(asSchema(branch), key));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsKey(asSchema(branch), key));
  }
  if (schema.additionalProperties !== false) {
    return false;
  }
  return !Object.hasOwn(schema.properties ?? {}, key);
}

/** Account schemas across every alternative, so unions are not skipped. */
function accountSchemasOf(schema: JsonSchemaLike | undefined): JsonSchemaLike[] {
  if (!schema) {
    return [];
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.flatMap((branch) => accountSchemasOf(asSchema(branch)));
  }
  const account = asSchema(asSchema(schema.properties?.accounts)?.additionalProperties);
  return account ? [account] : [];
}

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

/**
 * resolveChannelAccountMediaMaxMb reads channels.<id>.mediaMaxMb and the
 * per-account form straight off raw channel config for any channel id, so a
 * channel that rejects the key breaks a documented cap the outbound path
 * already consults.
 */
const channels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => entry.channelId);

describe("channel mediaMaxMb contract", () => {
  it("covers the bundled channels", () => {
    expect(channels.length).toBeGreaterThan(0);
  });

  it.each(channels)("%s accepts channels.<id>.mediaMaxMb", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "mediaMaxMb")).toBe(false);
  });

  it.each(channels)("%s accepts channels.<id>.accounts.<account>.mediaMaxMb", (channelId) => {
    for (const account of accountSchemasOf(schemaFor(channelId))) {
      expect(rejectsKey(account, "mediaMaxMb")).toBe(false);
    }
  });
});
