import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { computeBaseConfigSchemaResponse } from "../../config/schema-base.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE_CONFIG_SCHEMA = computeBaseConfigSchemaResponse({
  generatedAt: "2026-05-05T00:00:00.000Z",
});

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function expectAbsent(source: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(source).not.toContain(fragment);
  }
}

function collectSchemaPaths(schema: unknown, prefix = ""): string[] {
  if (!isRecord(schema)) {
    return [];
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return [
    ...Object.entries(properties).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path].concat(collectSchemaPaths(value, path));
    }),
    ...collectSchemaPaths(schema.additionalProperties, prefix ? `${prefix}.*` : "*"),
    ...collectSchemaPaths(schema.items, prefix ? `${prefix}[]` : "[]"),
  ];
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected record");
  }
  return value;
}

describe("config footprint guardrails", () => {
  it("keeps plugin entry config generic in the generated base schema", () => {
    const root = assertRecord(BASE_CONFIG_SCHEMA.schema);
    const plugins = assertRecord(assertRecord(root.properties).plugins);
    const entries = assertRecord(assertRecord(plugins.properties).entries);
    const entry = assertRecord(entries.additionalProperties);
    const pluginConfig = assertRecord(assertRecord(entry.properties).config);
    expect(pluginConfig.type).toBe("object");
    expect(pluginConfig.additionalProperties).toStrictEqual({});
    expect(pluginConfig.properties).toBeUndefined();
  });

  it("keeps retired legacy paths out of the generated base config schema", () => {
    const basePaths = new Set(collectSchemaPaths(BASE_CONFIG_SCHEMA.schema));

    const retired = {
      talk: "voiceId voiceAliases modelId outputFormat apiKey",
      "talk.providers.*": "voiceId voiceAliases modelId outputFormat",
      "agents.defaults.sandbox": "perSession",
      "hooks.internal": "handlers",
      "channels.telegram":
        "groupMentionsOnly streamMode chunkMode blockStreaming draftChunk blockStreamingCoalesce",
      "channels.slack":
        "streamMode chunkMode blockStreaming blockStreamingCoalesce nativeStreaming channels.*.allow accounts.*.channels.*.allow",
      "channels.discord":
        "streamMode chunkMode blockStreaming draftChunk blockStreamingCoalesce channels.*.allow accounts.*.channels.*.allow",
      "channels.googlechat": "streamMode groups.*.allow accounts.*.groups.*.allow",
    };
    const retiredPaths = Object.entries(retired).flatMap(([prefix, fields]) =>
      fields.split(" ").map((field) => `${prefix}.${field}`),
    );
    expect(retiredPaths.filter((path) => basePaths.has(path))).toStrictEqual([]);
  });

  it("keeps bundled channel private-network config canonical in generated metadata", () => {
    for (const pluginId of ["matrix", "nextcloud-talk", "tlon"]) {
      const metadata = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
        (entry) => entry.pluginId === pluginId,
      );
      expect(metadata, `${pluginId} metadata`).toBeDefined();
      const paths = collectSchemaPaths(metadata?.schema);
      expect(paths, pluginId).not.toContain("allowPrivateNetwork");
      expect(paths, pluginId).toContain("network.dangerouslyAllowPrivateNetwork");
    }
  });

  it("keeps retired flat streaming aliases out of channel-owned schemas", () => {
    for (const plugin of ["telegram", "discord", "msteams", "slack"]) {
      expectAbsent(readSource(`extensions/${plugin}/src/config-schema.ts`), [
        'streamMode: z.enum(["replace", "status_final", "append"])',
        "draftChunk:",
        "nativeStreaming:",
      ]);
    }
  });

  it("keeps channel schema ownership behind canonical SDK facades", () => {
    const bundledSource = readSource("src/plugin-sdk/bundled-channel-config-schema.ts");
    expectAbsent(
      readSource("src/plugin-sdk/channel-config-schema.ts"),
      "Discord GoogleChat IMessage MSTeams Signal Slack Telegram WhatsApp"
        .split(" ")
        .map((name) => `${name}ConfigSchema`),
    );
    expect(bundledSource).toContain(
      'export { GoogleChatConfigSchema } from "../config/zod-schema.providers-googlechat.js";',
    );
    expect(bundledSource).toContain(
      'export { WhatsAppConfigSchema } from "../config/zod-schema.providers-whatsapp.js";',
    );
    const primitives = readSource("src/plugin-sdk/channel-config-primitives.ts");
    for (const facade of [primitives, bundledSource]) {
      expect(facade).toContain('from "./channel-config-schema.js";');
      expectAbsent(facade, ["../channels/"]);
    }
    expectAbsent(primitives, ["../config/"]);
  });
});
