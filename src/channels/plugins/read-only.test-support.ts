import fs from "node:fs";
import path from "node:path";
import {
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  useNoBundledPlugins,
} from "../../plugins/loader.test-fixtures.js";
import type { PluginPackageChannel } from "../../plugins/package-manifest.types.js";

export function writeExternalSetupChannelPlugin(
  options: {
    setupEntry?: boolean;
    pluginDir?: string;
    pluginId?: string;
    channelId?: string;
    manifestChannelIds?: string[];
    manifestChannelConfig?: boolean;
    manifestChannelDescription?: string;
    manifestChannelLabel?: string;
    packagePresentation?: Pick<
      PluginPackageChannel,
      "label" | "blurb" | "selectionLabel" | "detailLabel" | "systemImage"
    >;
    setupRequiresRuntime?: boolean;
    setupChannelId?: string;
  } = {},
) {
  useNoBundledPlugins();
  const pluginDir = options.pluginDir ?? makePluginLoaderTempDir();
  const pluginId = options.pluginId ?? "external-chat";
  const channelId = options.channelId ?? "external-chat";
  const manifestChannelIds = options.manifestChannelIds ?? [channelId];
  const setupChannelId = options.setupChannelId ?? channelId;
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const setupEntry = options.setupEntry !== false;

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: `@example/openclaw-${pluginId}`,
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.cjs"],
          ...(setupEntry ? { setupEntry: "./setup-entry.cjs" } : {}),
          channel: {
            id: channelId,
            ...options.packagePresentation,
            configuredState: { env: { anyOf: ["EXTERNAL_CHAT_TOKEN"] } },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        channels: manifestChannelIds,
        ...(typeof options.setupRequiresRuntime === "boolean"
          ? { setup: { requiresRuntime: options.setupRequiresRuntime } }
          : {}),
        ...(options.manifestChannelConfig
          ? {
              channelConfigs: Object.fromEntries(
                manifestChannelIds.map((id) => [
                  id,
                  {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        token: { type: "string" },
                      },
                    },
                    uiHints: {
                      token: {
                        label: "Token",
                        sensitive: true,
                      },
                    },
                    label: options.manifestChannelLabel ?? "External Chat Manifest",
                    description: options.manifestChannelDescription ?? "manifest config",
                    preferOver: ["legacy-external-chat"],
                  },
                ]),
              ),
            }
          : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(channelId)},
        meta: {
          id: ${JSON.stringify(channelId)},
          label: "External Chat",
          selectionLabel: "External Chat",
          docsPath: ${JSON.stringify(`/channels/${channelId}`)},
          blurb: "full entry",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (cfg) => ({
            accountId: "default",
            token: cfg.channels?.[${JSON.stringify(channelId)}]?.token ?? "configured",
          }),
        },
        outbound: { deliveryMode: "direct" },
        secrets: {
          secretTargetRegistryEntries: [
            {
              id: ${JSON.stringify(`channels.${channelId}.token`)},
              targetType: "channel",
              configFile: "openclaw.json",
              pathPattern: ${JSON.stringify(`channels.${channelId}.token`)},
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
        },
      },
    });
  },
};`,
    "utf-8",
  );
  if (setupEntry) {
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: ${JSON.stringify(setupChannelId)},
    meta: {
      id: ${JSON.stringify(setupChannelId)},
      label: "External Chat",
      selectionLabel: "External Chat",
      docsPath: ${JSON.stringify(`/channels/${setupChannelId}`)},
      blurb: "setup entry",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => ({
        accountId: "default",
        token: cfg.channels?.[${JSON.stringify(setupChannelId)}]?.token ?? "configured",
      }),
    },
    outbound: { deliveryMode: "direct" },
    secrets: {
      secretTargetRegistryEntries: [
            {
              id: ${JSON.stringify(`channels.${setupChannelId}.token`)},
              targetType: "channel",
              configFile: "openclaw.json",
              pathPattern: ${JSON.stringify(`channels.${setupChannelId}.token`)},
          secretShape: "secret_input",
          expectedResolvedValue: "string",
          includeInPlan: true,
          includeInConfigure: true,
          includeInAudit: true,
        },
      ],
    },
  },
};`,
      "utf-8",
    );
  }

  return { pluginDir, fullMarker, setupMarker };
}
