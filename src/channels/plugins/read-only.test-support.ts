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
    manifestGatewayMessageActions?: string[];
    packagePresentation?: Pick<
      PluginPackageChannel,
      "label" | "blurb" | "selectionLabel" | "detailLabel" | "systemImage"
    >;
    setupRequiresRuntime?: boolean;
    setupChannelId?: string;
    bundled?: { persistedAuthPath?: string };
  } = {},
) {
  const bundledRoot = options.bundled ? makePluginLoaderTempDir() : undefined;
  if (bundledRoot) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  } else {
    useNoBundledPlugins();
  }
  const pluginId = options.pluginId ?? (options.bundled ? "bundled-chat" : "external-chat");
  const channelId = options.channelId ?? (options.bundled ? "bundled-chat" : "external-chat");
  const envVar = options.bundled ? "BUNDLED_CHAT_TOKEN" : "EXTERNAL_CHAT_TOKEN";
  const pluginDir =
    options.pluginDir ??
    (bundledRoot ? path.join(bundledRoot, pluginId) : makePluginLoaderTempDir());
  fs.mkdirSync(pluginDir, { recursive: true });
  const manifestChannelIds = options.manifestChannelIds ?? [channelId];
  const setupChannelId = options.setupChannelId ?? channelId;
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const setupEntry = options.setupEntry !== false;
  const label = options.bundled ? "Bundled Chat" : "External Chat";
  const meta = {
    id: channelId,
    label,
    selectionLabel: label,
    docsPath: `/channels/${channelId}`,
    blurb: "bundled setup entry",
  };
  const persistedAuthPath = options.bundled?.persistedAuthPath;
  const writeSource = (name: string, source: string) =>
    fs.writeFileSync(path.join(pluginDir, name), source, "utf-8");

  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(pluginDir, name), JSON.stringify(value, null, 2), "utf-8");
  writeJson("package.json", {
    name: options.bundled ? `@openclaw/${pluginId}` : `@example/openclaw-${pluginId}`,
    version: "1.0.0",
    ...(options.bundled ? { type: "commonjs" } : {}),
    openclaw: {
      extensions: ["./index.cjs"],
      ...(setupEntry ? { setupEntry: "./setup-entry.cjs" } : {}),
      channel: {
        ...(options.bundled ? meta : { id: channelId }),
        ...options.packagePresentation,
        configuredState: { env: { anyOf: [envVar] } },
        ...(persistedAuthPath
          ? { persistedAuthState: { specifier: "./auth-state.cjs", exportName: "hasAuth" } }
          : {}),
      },
    },
  });
  if (persistedAuthPath) {
    writeSource(
      "auth-state.cjs",
      `exports.hasAuth = () => require("node:fs").existsSync(${JSON.stringify(persistedAuthPath)});\n`,
    );
  }
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
                ...(options.manifestGatewayMessageActions
                  ? { gatewayMessageActions: options.manifestGatewayMessageActions }
                  : {}),
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
          label: ${JSON.stringify(label)},
          selectionLabel: ${JSON.stringify(label)},
          docsPath: ${JSON.stringify(`/channels/${id}`)},
          blurb: ${JSON.stringify(blurb)},
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (cfg) => ({
            accountId: "default",
            token: ${options.bundled ? '"configured"' : `cfg.channels?.[${JSON.stringify(id)}]?.token ?? "configured"`},
          }),
        },
        outbound: { deliveryMode: "direct" },
        ${
          options.bundled
            ? ""
            : `secrets: {
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
        },`
        }
      }`;
  const mark = (marker: string) =>
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");`;
  writeSource(
    "index.cjs",
    mark(fullMarker) +
      (options.bundled
        ? ""
        : `
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerChannel({ plugin: ${pluginSource(channelId, "full entry")} });
  },
};`),
  );
  if (setupEntry) {
    writeSource(
      "setup-entry.cjs",
      options.bundled
        ? `module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() {
    ${mark(setupMarker)}
    return ${pluginSource(setupChannelId, "bundled setup entry")};
  },
};`
        : `${mark(setupMarker)}
module.exports = {
  plugin: ${pluginSource(setupChannelId, "setup entry")},
};`,
    );
  }

  return { pluginDir, fullMarker, setupMarker, bundledRoot, pluginId, channelId, envVar };
}

export function writeBundledSetupChannelPlugin(options: { persistedAuthPath?: string } = {}) {
  const fixture = writeExternalSetupChannelPlugin({ bundled: options });
  return { ...fixture, bundledRoot: path.dirname(fixture.pluginDir) };
}
