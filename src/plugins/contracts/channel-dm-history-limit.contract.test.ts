// Verifies DM-capable channels accept the documented dmHistoryLimit override.
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
 * docs/gateway/config-channels.md states the DM history resolver reads
 * channels.<provider>.dmHistoryLimit for any channel with provider:direct:<id>
 * sessions, "not just a fixed list", so every channel exposing a DM policy has
 * to accept the key. Channels without a DM surface are out of scope.
 */
/**
 * DM-capable channels that publish no dmPolicy surface. Raft and Reef declare
 * `chatTypes: ["direct"]` and Tlon includes "direct" (`channel.ts:110` in each),
 * and all three build `kind: "direct"` routes, so the session-key resolver
 * applies the key for them even though there is no dmPolicy to key on.
 */
const DM_ROUTING_CHANNELS_WITHOUT_DM_POLICY = ["raft", "reef", "tlon"] as const;

const dmCapableChannels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
  (entry) =>
    Object.hasOwn(asSchema(entry.schema)?.properties ?? {}, "dmPolicy") ||
    (DM_ROUTING_CHANNELS_WITHOUT_DM_POLICY as readonly string[]).includes(entry.channelId),
).map((entry) => entry.channelId);

describe("channel dmHistoryLimit contract", () => {
  it("finds DM-capable bundled channels", () => {
    expect(dmCapableChannels.length).toBeGreaterThan(0);
  });

  it.each(dmCapableChannels)("%s accepts channels.<id>.dmHistoryLimit", (channelId) => {
    const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
      (candidate) => candidate.channelId === channelId,
    );
    expect(rejectsKey(asSchema(entry?.schema), "dmHistoryLimit")).toBe(false);
  });

  // The same doc sentence covers the per-DM override, and the resolver reads
  // dms.<id>.historyLimit before falling back to dmHistoryLimit.
  it.each(dmCapableChannels)("%s accepts channels.<id>.dms.<id>.historyLimit", (channelId) => {
    const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
      (candidate) => candidate.channelId === channelId,
    );
    expect(rejectsKey(asSchema(entry?.schema), "dms")).toBe(false);
    const dms = asSchema(asSchema(entry?.schema)?.properties?.dms);
    expect(rejectsKey(asSchema(dms?.additionalProperties), "historyLimit")).toBe(false);
  });
});
