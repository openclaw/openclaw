// Verifies group-capable bundled channels accept the documented historyLimit override.
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
 * docs/gateway/config-channels.md documents channels.<channel>.historyLimit as a
 * per-channel override of messages.groupChat.historyLimit, and the resolver in
 * src/agents/embedded-agent-runner/history.ts returns it for channel and group
 * sessions on any provider. Channels with no group surface never reach that
 * branch, so only group-capable channels owe the key.
 */
const groupCapableChannels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => {
  const properties = asSchema(entry.schema)?.properties ?? {};
  return (
    Object.hasOwn(properties, "groupPolicy") ||
    Object.hasOwn(properties, "groups") ||
    Object.hasOwn(properties, "groupAllowFrom")
  );
}).map((entry) => entry.channelId);

describe("channel historyLimit contract", () => {
  it("covers the group-capable bundled channels", () => {
    expect(groupCapableChannels.length).toBeGreaterThan(0);
  });

  it.each(groupCapableChannels)("%s accepts channels.<id>.historyLimit", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "historyLimit")).toBe(false);
  });

  it.each(groupCapableChannels)(
    "%s accepts channels.<id>.accounts.<account>.historyLimit",
    (channelId) => {
      for (const account of accountSchemasOf(schemaFor(channelId))) {
        expect(rejectsKey(account, "historyLimit")).toBe(false);
      }
    },
  );
});
