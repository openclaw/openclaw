import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { computeBaseConfigSchemaResponse } from "../../config/schema-base.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
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
      if (metadata === undefined) {
        throw new Error(`${pluginId} metadata missing`);
      }
      const paths = new Set(collectSchemaPaths(metadata.schema));
      expect([...paths], pluginId).not.toContain("allowPrivateNetwork");
      expect([...paths], pluginId).toContain("network.dangerouslyAllowPrivateNetwork");
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

  it("keeps retired config aliases out of the shared setup input", () => {
    expectAbsent(readSource("src/channels/plugins/types.core.ts"), [
      ...["streamMode", "groupMentionsOnly", "perSession", "voiceId", "apiKey"].map(
        (field) => `${field}?:`,
      ),
      "allow?: boolean;",
    ]);
  });

  it("keeps current channel schemas plugin-owned behind shipped compatibility exports", () => {
    const source = readSource("src/plugin-sdk/channel-config-schema.ts");
    const bundledSource = readSource("src/plugin-sdk/bundled-channel-config-schema.ts");
    const section = bundledSource.slice(bundledSource.indexOf("Bundled-channel config schemas"));
    const matches = (text: string, pattern: RegExp) =>
      Array.from(text.matchAll(pattern)).flatMap((match) => match[1] ?? []);
    const blocks = matches(
      section,
      /export \{([^}]*)\} from "\.\.\/config\/zod-schema\.providers-(?:googlechat|whatsapp)\.js";/g,
    );
    expect(blocks).toHaveLength(2);
    const names = [
      ...matches(blocks.join("\n"), /\b([A-Z][A-Za-z0-9]+ConfigSchema)\b/g),
      ...matches(section, /\bexport const ([A-Z][A-Za-z0-9]+ConfigSchema)\b/g),
    ].toSorted((a, b) => a.localeCompare(b));
    expect(names).toEqual(
      "Discord GoogleChat IMessage MSTeams Signal Slack Telegram WhatsApp"
        .split(" ")
        .map((name) => `${name}ConfigSchema`),
    );
    expectAbsent(source, names);
    expect(bundledSource).toContain("Bundled-channel config schemas");
    expect(bundledSource).toContain("openclaw/plugin-sdk/channel-config-schema");
    expect(bundledSource).toMatch(
      /loadBundledConfigSchema<[^;]+?>\(\s*"imessage",\s*"IMessageConfigSchema",?\s*\)/u,
    );
    expect(bundledSource).toMatch(
      /loadBundledConfigSchema<[^;]+?>\(\s*"telegram",\s*"TelegramConfigSchema",?\s*\)/u,
    );
    const primitives = readSource("src/plugin-sdk/channel-config-primitives.ts");
    for (const facade of [primitives, bundledSource]) {
      expect(facade).toContain('from "./channel-config-schema.js";');
      expectAbsent(facade, ["../channels/"]);
    }
    expectAbsent(primitives, ["../config/"]);
  });

  it("keeps internal src imports off the non-canonical channel config schema facades", () => {
    // channel-config-schema is the canonical internal module; the primitives
    // and bundled shells stay export-compatible for plugins only.
    const allowedShellImporters = new Set([
      // The compatibility test exercises the shipped facade exports.
      "src/plugin-sdk/shipped-channel-compat.test.ts",
      // This guardrail file embeds facade specifiers in shell-shape assertions.
      "src/plugins/contracts/config-footprint-guardrails.test.ts",
    ]);
    const facadeImportPattern =
      /\bfrom\s*["'][^"']*(?:channel-config-primitives|bundled-channel-config-schema)(?:\.js)?["']/u;
    const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: "src" });
    if (!files) {
      throw new Error("unable to list tracked source files for the config facade guard");
    }

    const offenders = files.filter((file) => {
      if (!(file.endsWith(".ts") || file.endsWith(".tsx")) || allowedShellImporters.has(file)) {
        return false;
      }
      return facadeImportPattern.test(readFileSync(resolve(REPO_ROOT, file), "utf8"));
    });

    expect(offenders).toStrictEqual([]);
  });
});
