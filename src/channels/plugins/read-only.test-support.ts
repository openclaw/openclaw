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

  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(pluginDir, name), JSON.stringify(value, null, 2), "utf-8");
  writeJson("package.json", {
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
  });
  writeJson("openclaw.plugin.json", {
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
                  properties: { token: { type: "string" } },
                },
                uiHints: { token: { label: "Token", sensitive: true } },
                label: options.manifestChannelLabel ?? "External Chat Manifest",
                description: options.manifestChannelDescription ?? "manifest config",
                preferOver: ["legacy-external-chat"],
              },
            ]),
          ),
        }
      : {}),
  });
  const pluginSource = (id: string, blurb: string) => `{
        id: ${JSON.stringify(id)},
        meta: {
          id: ${JSON.stringify(id)},
          label: "External Chat",
          selectionLabel: "External Chat",
          docsPath: ${JSON.stringify(`/channels/${id}`)},
          blurb: ${JSON.stringify(blurb)},
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (cfg) => ({
            accountId: "default",
            token: cfg.channels?.[${JSON.stringify(id)}]?.token ?? "configured",
          }),
        },
        outbound: { deliveryMode: "direct" },
        secrets: {
          secretTargetRegistryEntries: [
            {
              id: ${JSON.stringify(`channels.${id}.token`)},
              targetType: "channel",
              configFile: "openclaw.json",
              pathPattern: ${JSON.stringify(`channels.${id}.token`)},
              secretShape: "secret_input",
              expectedResolvedValue: "string",
              includeInPlan: true,
              includeInConfigure: true,
              includeInAudit: true,
            },
          ],
        },
      }`;
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerChannel({ plugin: ${pluginSource(channelId, "full entry")} });
  },
};`,
    "utf-8",
  );
  if (setupEntry) {
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: ${pluginSource(setupChannelId, "setup entry")},
};`,
      "utf-8",
    );
  }

  return { pluginDir, fullMarker, setupMarker };
}
