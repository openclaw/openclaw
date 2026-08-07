// Verifies channel config schema ownership across plugin origins and replacement declarations.
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";

function createSlackChannelPlugin(params: {
  id: string;
  origin: PluginOrigin;
  extraProperty?: string;
  preferOver?: string[];
}): PluginManifestRecord {
  return {
    id: params.id,
    channels: ["slack"],
    channelConfigs: {
      slack: {
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

function selectSlackSchemaOwner(plugins: PluginManifestRecord[]) {
  const registry: PluginManifestRegistry = { diagnostics: [], plugins };
  const entry = collectChannelSchemaMetadataWithOwnership(registry).find(
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
const REPLACED_SLACK = createSlackChannelPlugin({ id: "openclaw-slack", origin: "global" });
const REPLACEMENT_SLACK = createSlackChannelPlugin({
  id: "acme-slack-thread-guard",
  origin: "global",
  extraProperty: "threadGuard",
  preferOver: ["openclaw-slack"],
});

describe("collectChannelSchemaMetadataWithOwnership", () => {
  for (const [order, plugins] of [
    ["replacement first", [REPLACEMENT_SLACK, REPLACED_SLACK]],
    ["replacement last", [REPLACED_SLACK, REPLACEMENT_SLACK]],
  ] as const) {
    it(`keeps the preferOver replacement schema at equal origin (${order})`, () => {
      expect(selectSlackSchemaOwner([...plugins])).toEqual({
        schemaPluginId: "acme-slack-thread-guard",
        // heartbeatVisibility is the core-owned property merged into installed channel schemas.
        properties: ["mode", "threadGuard", "heartbeatVisibility"],
      });
    });
  }

  it("lets a closer origin override a preferOver replacement", () => {
    const owner = selectSlackSchemaOwner([
      REPLACEMENT_SLACK,
      createSlackChannelPlugin({
        id: "workspace-slack",
        origin: "workspace",
        extraProperty: "workspaceOnly",
      }),
    ]);

    expect(owner.schemaPluginId).toBe("workspace-slack");
  });

  it("keeps registry order deciding equal-origin plugins that declare no replacement", () => {
    const owner = selectSlackSchemaOwner([
      createSlackChannelPlugin({
        id: "acme-slack-thread-guard",
        origin: "global",
        extraProperty: "threadGuard",
      }),
      REPLACED_SLACK,
    ]);

    expect(owner.schemaPluginId).toBe("openclaw-slack");
  });
});
