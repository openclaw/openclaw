import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

function collectSchemaPaths(schema: unknown, prefix = ""): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const out: string[] = [];
  const candidate = schema as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
    items?: unknown;
  };

  if (candidate.properties && typeof candidate.properties === "object") {
    for (const [key, value] of Object.entries(candidate.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      out.push(...collectSchemaPaths(value, path));
    }
  }

  if (
    candidate.additionalProperties &&
    typeof candidate.additionalProperties === "object" &&
    !Array.isArray(candidate.additionalProperties)
  ) {
    const path = prefix ? `${prefix}.*` : "*";
    out.push(...collectSchemaPaths(candidate.additionalProperties, path));
  }

  if (candidate.items && typeof candidate.items === "object" && !Array.isArray(candidate.items)) {
    const path = prefix ? `${prefix}[]` : "[]";
    out.push(...collectSchemaPaths(candidate.items, path));
  }

  return out;
}

describe("config footprint guardrails", () => {
  it("keeps bundled channel private-network config canonical in generated metadata", () => {
    const pluginIds = ["matrix", "nextcloud-talk", "tlon"];

    for (const pluginId of pluginIds) {
      const metadata = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.pluginId === pluginId,
      );
      if (metadata === undefined) {
        throw new Error(`${pluginId} metadata missing`);
      }
      const paths = new Set(collectSchemaPaths(metadata.schema));
      expect(paths.has("allowPrivateNetwork"), `${pluginId} leaked flat allowPrivateNetwork`).toBe(
        false,
      );
      expect(
        paths.has("network.dangerouslyAllowPrivateNetwork"),
        `${pluginId} missing canonical network.dangerouslyAllowPrivateNetwork`,
      ).toBe(true);
    }
  });
});
