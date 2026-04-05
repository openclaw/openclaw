import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { GENERATED_BASE_CONFIG_SCHEMA } from "../../config/schema.base.generated.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

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
  it("keeps retired legacy paths out of the generated base config schema", () => {
    const basePaths = new Set(collectSchemaPaths(GENERATED_BASE_CONFIG_SCHEMA.schema));

    expect(
      [
        "talk.voiceId",
        "talk.voiceAliases",
        "talk.modelId",
        "talk.outputFormat",
        "talk.apiKey",
        "talk.providers.*.voiceId",
        "talk.providers.*.voiceAliases",
        "talk.providers.*.modelId",
        "talk.providers.*.outputFormat",
        "agents.defaults.sandbox.perSession",
        "hooks.internal.handlers",
        "channels.telegram.groupMentionsOnly",
        "channels.telegram.streamMode",
        "channels.slack.streamMode",
        "channels.discord.streamMode",
        "channels.googlechat.streamMode",
        "channels.slack.channels.*.allow",
        "channels.slack.accounts.*.channels.*.allow",
        "channels.googlechat.groups.*.allow",
        "channels.googlechat.accounts.*.groups.*.allow",
        "channels.discord.channels.*.allow",
        "channels.discord.accounts.*.channels.*.allow",
      ].filter((path) => basePaths.has(path)),
    ).toEqual([]);
  });

  it("keeps bundled channel private-network config canonical in generated metadata", () => {
    const pluginIds = ["bluebubbles", "matrix", "mattermost", "nextcloud-talk", "tlon"];

    for (const pluginId of pluginIds) {
      const metadata = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.pluginId === pluginId,
      );
      expect(metadata, `${pluginId} metadata missing`).toBeDefined();
      const paths = new Set(collectSchemaPaths(metadata?.schema));
      expect(paths.has("allowPrivateNetwork"), `${pluginId} leaked flat allowPrivateNetwork`).toBe(
        false,
      );
      expect(
        paths.has("network.dangerouslyAllowPrivateNetwork"),
        `${pluginId} missing canonical network.dangerouslyAllowPrivateNetwork`,
      ).toBe(true);
    }
  });

  it("keeps shared setup input canonical-first", () => {
    const source = readSource("src/channels/plugins/types.core.ts");

    expect(source).toContain("dangerouslyAllowPrivateNetwork?: boolean;");
    expect(source).toContain("allowPrivateNetwork?: boolean;");
    expect(source).not.toContain("streamMode?:");
    expect(source).not.toContain("groupMentionsOnly?:");
    expect(source).not.toContain("perSession?:");
    expect(source).not.toContain("voiceId?:");
    expect(source).not.toContain("apiKey?:");
    expect(source).not.toContain("allow?: boolean;");
  });

  it("keeps plugin-sdk private-network helpers canonical-first with a narrow compat alias", () => {
    const source = readSource("src/plugin-sdk/ssrf-policy.ts");

    expect(source).toContain("export function ssrfPolicyFromDangerouslyAllowPrivateNetwork(");
    expect(source).toContain("export function ssrfPolicyFromAllowPrivateNetwork(");
    expect(source).toContain(
      "return ssrfPolicyFromDangerouslyAllowPrivateNetwork(allowPrivateNetwork);",
    );
  });
});
