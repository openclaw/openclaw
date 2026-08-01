// Verifies every bundled channel accepts the documented heartbeatVisibility override.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

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

/**
 * Any bundled channel can be a heartbeat delivery target (config validation
 * builds the allowed target set from every bundled channel id), and the
 * visibility resolver reads channels.<id>.heartbeatVisibility for whichever
 * channel it delivers to, so no bundled channel may reject the key.
 */
const channels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => entry.channelId);

describe("channel heartbeatVisibility contract", () => {
  it("covers the bundled channels", () => {
    expect(channels.length).toBeGreaterThan(0);
  });

  it.each(channels)("%s accepts channels.<id>.heartbeatVisibility", (channelId) => {
    const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
      (candidate) => candidate.channelId === channelId,
    );
    expect(rejectsKey(asSchema(entry?.schema), "heartbeatVisibility")).toBe(false);
  });

  it.each(channels)(
    "%s accepts channels.<id>.accounts.<account>.heartbeatVisibility",
    (channelId) => {
      const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (candidate) => candidate.channelId === channelId,
      );
      const accounts = asSchema(asSchema(entry?.schema)?.properties?.accounts);
      expect(rejectsKey(asSchema(accounts?.additionalProperties), "heartbeatVisibility")).toBe(
        false,
      );
    },
  );
});
