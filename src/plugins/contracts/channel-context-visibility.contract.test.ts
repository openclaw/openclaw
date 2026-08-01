// Verifies channels whose runtime resolves supplemental context visibility accept the key.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

/**
 * Channels whose own runtime calls resolveChannelContextVisibilityMode, so the
 * documented per-channel override in docs/channels/groups.md must validate.
 * Rejecting it refuses the whole config, not just the key.
 */
const CONTEXT_VISIBILITY_CHANNELS = ["feishu", "mattermost"] as const;

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/** A closed schema without the key is what makes config loading fail. */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema || schema.additionalProperties !== false) {
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

describe("channel contextVisibility contract", () => {
  it.each(CONTEXT_VISIBILITY_CHANNELS)(
    "%s accepts channels.<id>.contextVisibility",
    (channelId) => {
      expect(rejectsKey(schemaFor(channelId), "contextVisibility")).toBe(false);
    },
  );

  it.each(CONTEXT_VISIBILITY_CHANNELS)(
    "%s accepts channels.<id>.accounts.<account>.contextVisibility",
    (channelId) => {
      const accounts = asSchema(schemaFor(channelId)?.properties?.accounts);
      expect(rejectsKey(asSchema(accounts?.additionalProperties), "contextVisibility")).toBe(false);
    },
  );
});
