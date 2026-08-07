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

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const orders: T[][] = [];
  for (const [index, item] of items.entries()) {
    for (const rest of permutations([...items.slice(0, index), ...items.slice(index + 1)])) {
      rest.unshift(item);
      orders.push(rest);
    }
  }
  return orders;
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
// A same-origin claimant unrelated to the replacement contract.
const UNRELATED_SLACK = createChannelPlugin({
  id: "zeta-slack-extras",
  origin: "global",
  extraProperty: "zetaOnly",
});
const CLOSER_ORIGIN_SLACK = createChannelPlugin({
  id: "operator-slack",
  origin: "config",
  extraProperty: "operatorOnly",
});
const TRAVERSAL_ORDERS = [
  ["replacement first", [REPLACEMENT_SLACK, REPLACED_SLACK]],
  ["replacement last", [REPLACED_SLACK, REPLACEMENT_SLACK]],
] as const;

function pluginEnabledConfig(pluginId: string, enabled: boolean): OpenClawConfig {
  return { plugins: { entries: { [pluginId]: { enabled } } } } as OpenClawConfig;
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
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("acme-slack-thread-guard", false))
          .schemaPluginId,
      ).toBe("openclaw-slack");
    });

    it(`keeps the enabled replacement when the plugin it supersedes is disabled (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("openclaw-slack", false))
          .schemaPluginId,
      ).toBe("acme-slack-thread-guard");
    });

    // Runtime policy only disables an implicitly selected superseded plugin, so an operator that
    // enabled it on purpose keeps the schema that validates its existing channel keys.
    it(`keeps an explicitly enabled superseded plugin's schema (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("openclaw-slack", true))
          .schemaPluginId,
      ).toBe("openclaw-slack");
    });
  }

  for (const [order, plugins] of [
    ["closer origin first", [CLOSER_ORIGIN_SLACK, REPLACEMENT_SLACK]],
    ["closer origin last", [REPLACEMENT_SLACK, CLOSER_ORIGIN_SLACK]],
  ] as const) {
    it(`hands a disabled closer-origin owner's schema to an active farther origin (${order})`, () => {
      expect(
        selectSlackSchemaOwner([...plugins], pluginEnabledConfig("operator-slack", false))
          .schemaPluginId,
      ).toBe("acme-slack-thread-guard");
    });
  }

  for (const claimants of permutations([REPLACEMENT_SLACK, REPLACED_SLACK, UNRELATED_SLACK])) {
    it(`resolves ownership across all claimants (${claimants.map((plugin) => plugin.id).join(" > ")})`, () => {
      expect(selectSlackSchemaOwner(claimants).schemaPluginId).toBe("acme-slack-thread-guard");
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

const CLOSER_ORIGIN_ACME = createChannelPlugin({
  id: "operator-acmechat",
  origin: "config",
  channelId: "acmechat",
  extraProperty: "operatorOnly",
});

function validateAcmeChatKeys(params: {
  plugins: PluginManifestRecord[];
  channel: Record<string, unknown>;
  entries: Record<string, { enabled: boolean }>;
}) {
  const result = validateConfigObjectWithPlugins(
    {
      agents: { list: [{ id: "openclaw" }] },
      channels: { acmechat: params.channel },
      plugins: { entries: params.entries },
    },
    {
      env: makeIsolatedEnv(),
      pluginMetadataSnapshot: {
        manifestRegistry: { diagnostics: [], plugins: params.plugins },
      },
    },
  );
  return result.ok ? [] : result.issues;
}

describe("config validate channel schema ownership", () => {
  for (const [order, plugins] of [
    ["replacement first", [REPLACEMENT_ACME, REPLACED_ACME]],
    ["replacement last", [REPLACED_ACME, REPLACEMENT_ACME]],
  ] as const) {
    it(`accepts the superseded plugin's channel keys while the replacement is disabled (${order})`, () => {
      expect(
        validateAcmeChatKeys({
          plugins: [...plugins],
          // legacyOption exists only in the superseded plugin's channel schema.
          channel: { legacyOption: {} },
          entries: { "acme-chat-thread-guard": { enabled: false } },
        }),
      ).toEqual([]);
    });

    it(`accepts an explicitly enabled superseded plugin's channel keys (${order})`, () => {
      expect(
        validateAcmeChatKeys({
          plugins: [...plugins],
          channel: { legacyOption: {} },
          entries: { "openclaw-acmechat": { enabled: true } },
        }),
      ).toEqual([]);
    });
  }

  it("accepts an active farther-origin plugin's channel keys while the closer origin is disabled", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [CLOSER_ORIGIN_ACME, REPLACEMENT_ACME],
        // threadGuard exists only in the active replacement's channel schema.
        channel: { threadGuard: {} },
        entries: { "operator-acmechat": { enabled: false } },
      }),
    ).toEqual([]);
  });
});
