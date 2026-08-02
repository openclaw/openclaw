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

function leavesOf(channelId: string, scope: "channel" | "account"): JsonSchemaLike[] {
  const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (candidate) => candidate.channelId === channelId,
  );
  return collectLeaves(asSchema(entry?.schema), scope);
}

/**
 * Twitch publishes a union of two strict shapes, so the leaf lives inside each
 * alternative rather than on a top-level `properties`. Walk the alternatives so
 * the canonical-field assertion actually covers composed schemas instead of
 * silently finding nothing.
 */
function collectLeaves(
  schema: JsonSchemaLike | undefined,
  scope: "channel" | "account",
): JsonSchemaLike[] {
  if (!schema) {
    return [];
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.flatMap((branch) => collectLeaves(asSchema(branch), scope));
  }
  const container =
    scope === "channel"
      ? schema
      : asSchema(asSchema(schema.properties?.accounts)?.additionalProperties);
  const leaf = asSchema(container?.properties?.heartbeatVisibility);
  return leaf ? [leaf] : [];
}

/** Account schemas across every alternative, so unions are not skipped. */
function accountSchemasOf(channelId: string): JsonSchemaLike[] {
  const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (candidate) => candidate.channelId === channelId,
  );
  const walk = (schema: JsonSchemaLike | undefined): JsonSchemaLike[] => {
    if (!schema) {
      return [];
    }
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      return alternatives.flatMap((branch) => walk(asSchema(branch)));
    }
    const account = asSchema(asSchema(schema.properties?.accounts)?.additionalProperties);
    return account ? [account] : [];
  };
  return walk(asSchema(entry?.schema));
}

describe("channel heartbeatVisibility contract", () => {
  it("covers the bundled channels", () => {
    expect(channels.length).toBeGreaterThan(0);
  });

  it.each(channels.filter((channelId) => !NON_CANONICAL_SHAPE_CHANNELS.has(channelId)))(
    "%s accepts the canonical heartbeatVisibility fields",
    (channelId) => {
      const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (candidate) => candidate.channelId === channelId,
      );
      const leaves = leavesOf(channelId, "channel");
      // Permissive channels (qqbot, synology-chat) accept the documented object
      // without declaring it, so only closed schemas owe a canonical leaf.
      if (!rejectsKey(asSchema(entry?.schema), "openclawProbeUnknownKey")) {
        return;
      }
      expect(leaves.length).toBeGreaterThan(0);
      for (const leaf of leaves) {
        for (const field of CANONICAL_FIELDS) {
          expect(rejectsKey(leaf, field)).toBe(false);
        }
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
      for (const account of accountSchemasOf(channelId)) {
        expect(rejectsKey(account, "heartbeatVisibility")).toBe(false);
      }
    },
  );

  it.each(channels.filter((channelId) => !NON_CANONICAL_SHAPE_CHANNELS.has(channelId)))(
    "%s accepts the canonical fields on accounts.<account>.heartbeatVisibility",
    (channelId) => {
      for (const leaf of leavesOf(channelId, "account")) {
        for (const field of CANONICAL_FIELDS) {
          expect(rejectsKey(leaf, field)).toBe(false);
        }
      }
    },
  );
});
