// Verifies channel config schema ownership across plugin origins and replacement declarations.
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { makeIsolatedEnv } from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createChannelPlugin(params: {
  id: string;
  origin: PluginOrigin;
  channelId?: string;
  extraProperty?: string;
  preferOver?: string[];
}): PluginManifestRecord {
  const channelId = params.channelId ?? "slack";
  return {
    id: params.id,
    channels: [channelId],
    configSchema: { type: "object", additionalProperties: false },
    channelConfigs: {
      [channelId]: {
        ...(params.preferOver ? { preferOver: params.preferOver } : {}),
        schema: {
          type: "object",
          properties: {
            mode: { type: "string" },
            ...(params.extraProperty ? { [params.extraProperty]: { type: "object" } } : {}),
          },
          additionalProperties: false,
        },
      },
    },
    cliBackends: [],
    hooks: [],
    manifestPath: `/tmp/${params.id}/openclaw.plugin.json`,
    origin: params.origin,
    providers: [],
    rootDir: `/tmp/${params.id}`,
    skills: [],
    source: `/tmp/${params.id}/index.js`,
  };
}

function selectSlackSchemaOwner(plugins: PluginManifestRecord[], config?: OpenClawConfig) {
  const registry: PluginManifestRegistry = { diagnostics: [], plugins };
  const entry = collectChannelSchemaMetadataWithOwnership(registry, config).find(
    (channel) => channel.id === "slack",
  );
  return {
    schemaPluginId: entry?.schemaPluginId,
    properties: Object.keys(
      (entry?.configSchema as { properties?: object } | undefined)?.properties ?? {},
    ),
  };
}

// Mirrors #92884: a replacement Slack plugin installed alongside the plugin it supersedes,
// adding a plugin-owned channels.slack.threadGuard block behind preferOver.
const REPLACED_SLACK = createChannelPlugin({ id: "openclaw-slack", origin: "global" });
const REPLACEMENT_SLACK = createChannelPlugin({
  id: "acme-slack-thread-guard",
  origin: "global",
  extraProperty: "threadGuard",
  preferOver: ["openclaw-slack"],
});
const TRAVERSAL_ORDERS = [
  ["replacement first", [REPLACEMENT_SLACK, REPLACED_SLACK]],
  ["replacement last", [REPLACED_SLACK, REPLACEMENT_SLACK]],
] as const;

function disabledPluginConfig(pluginId: string): OpenClawConfig {
  return { plugins: { entries: { [pluginId]: { enabled: false } } } } as OpenClawConfig;
}

describe("collectChannelSchemaMetadataWithOwnership", () => {
  for (const [order, plugins] of TRAVERSAL_ORDERS) {
    it(`keeps the preferOver replacement schema at equal origin (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toEqual({
        schemaPluginId: "acme-slack-thread-guard",
        // heartbeatVisibility is the core-owned property merged into installed channel schemas.
        properties: ["mode", "threadGuard", "heartbeatVisibility"],
      });
    });

    it(`drops a disabled replacement's preferOver claim at equal origin (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], disabledPluginConfig("acme-slack-thread-guard"))
          .schemaPluginId,
      ).toBe("openclaw-slack");
    });

    it(`keeps the enabled replacement when the plugin it supersedes is disabled (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], disabledPluginConfig("openclaw-slack")).schemaPluginId,
      ).toBe("acme-slack-thread-guard");
    });
  }

  it("lets a closer origin override a preferOver replacement", () => {
    const owner = selectSlackSchemaOwner([
      REPLACEMENT_SLACK,
      createChannelPlugin({
        id: "workspace-slack",
        origin: "workspace",
        extraProperty: "workspaceOnly",
      }),
    ]);

    expect(owner.schemaPluginId).toBe("workspace-slack");
  });

  it("keeps registry order deciding equal-origin plugins that declare no replacement", () => {
    const owner = selectSlackSchemaOwner([
      createChannelPlugin({
        id: "acme-slack-thread-guard",
        origin: "global",
        extraProperty: "threadGuard",
      }),
      REPLACED_SLACK,
    ]);

    expect(owner.schemaPluginId).toBe("openclaw-slack");
  });
});

// Plugin-owned channel id so the assertion covers collected plugin schemas only, without the
// bundled channel Zod refinements that run before manifest-backed channel schema validation.
const REPLACED_ACME = createChannelPlugin({
  id: "openclaw-acmechat",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "legacyOption",
});
const REPLACEMENT_ACME = createChannelPlugin({
  id: "acme-chat-thread-guard",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "threadGuard",
  preferOver: ["openclaw-acmechat"],
});

describe("config validate channel schema ownership", () => {
  for (const [order, plugins] of [
    ["replacement first", [REPLACEMENT_ACME, REPLACED_ACME]],
    ["replacement last", [REPLACED_ACME, REPLACEMENT_ACME]],
  ] as const) {
    it(`accepts the superseded plugin's channel keys while the replacement is disabled (${order})`, () => {
      const result = validateConfigObjectWithPlugins(
        {
          agents: { list: [{ id: "openclaw" }] },
          // legacyOption exists only in the superseded plugin's channel schema.
          channels: { acmechat: { legacyOption: {} } },
          plugins: { entries: { "acme-chat-thread-guard": { enabled: false } } },
        },
        {
          env: makeIsolatedEnv(),
          pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [...plugins] } },
        },
      );

      expect(result.ok ? [] : result.issues).toEqual([]);
    });
  }
});
