// Verifies reply-capable channels accept the documented replyToMode override.
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

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

/**
 * Channels whose outbound path emits replyToId, so the channel-agnostic filter
 * in src/auto-reply/reply/reply-threading.ts governs them and the documented
 * per-channel override has to validate.
 *
 * Excluded on purpose: imessage and msteams omit the key via
 * buildCommonChannelAccountShape; zalo and zalouser pin it through
 * createStaticReplyToModeResolver("off"), so config would be ignored; line,
 * nostr, raft, sms and twitch emit no reply target at all.
 */
const REPLY_CAPABLE_CHANNELS = [
  "buzz",
  "clickclack",
  "feishu",
  "irc",
  "nextcloud-talk",
  "qa-channel",
  "reef",
  "tlon",
] as const;

describe("channel replyToMode contract", () => {
  it.each(REPLY_CAPABLE_CHANNELS)("%s accepts channels.<id>.replyToMode", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "replyToMode")).toBe(false);
  });

  it.each(REPLY_CAPABLE_CHANNELS)(
    "%s exposes replyToMode as the shared enum, not a channel-local spelling",
    (channelId) => {
      const leaf = asSchema(schemaFor(channelId)?.properties?.replyToMode);
      expect(leaf).toBeDefined();
    },
  );
});
