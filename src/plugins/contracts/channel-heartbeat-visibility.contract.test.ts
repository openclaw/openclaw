// Verifies every bundled channel accepts the documented heartbeatVisibility override.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/**
 * A closed schema without the key is what makes config loading fail. Twitch
 * publishes a union of two strict shapes rather than one flat object, so the
 * key is only refused when every alternative refuses it.
 */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.every((branch) => rejectsKey(asSchema(branch), key));
  }
  if (schema.additionalProperties !== false) {
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

/** Fields src/infra/heartbeat-visibility.ts actually reads. */
const CANONICAL_FIELDS = ["showOk", "showAlerts", "useIndicator"] as const;

/**
 * Feishu declares an unrelated {visibility, intervalMs} object under the same
 * key. The resolver reads neither field, so its heartbeat visibility is inert,
 * but replacing that shape invalidates configs that validate today and needs a
 * doctor migration, so it is tracked separately rather than changed here.
 */
const NON_CANONICAL_SHAPE_CHANNELS = new Set(["feishu"]);

function leafOf(channelId: string, scope: "channel" | "account"): JsonSchemaLike | undefined {
  const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (candidate) => candidate.channelId === channelId,
  );
  const root = asSchema(entry?.schema);
  const container =
    scope === "channel"
      ? root
      : asSchema(asSchema(root?.properties?.accounts)?.additionalProperties);
  return asSchema(container?.properties?.heartbeatVisibility);
}

describe("channel heartbeatVisibility contract", () => {
  it("covers the bundled channels", () => {
    expect(channels.length).toBeGreaterThan(0);
  });

  it.each(channels.filter((channelId) => !NON_CANONICAL_SHAPE_CHANNELS.has(channelId)))(
    "%s accepts the canonical heartbeatVisibility fields",
    (channelId) => {
      const leaf = leafOf(channelId, "channel");
      if (!leaf) {
        return;
      }
      for (const field of CANONICAL_FIELDS) {
        expect(rejectsKey(leaf, field)).toBe(false);
      }
    },
  );

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
