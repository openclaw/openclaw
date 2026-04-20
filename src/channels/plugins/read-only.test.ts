import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../../plugins/loader.test-fixtures.js";
import { listReadOnlyChannelPluginsForConfig } from "./read-only.js";

function writeExternalSetupChannelPlugin(
  options: {
    setupEntry?: boolean;
    pluginDir?: string;
    pluginId?: string;
    channelId?: string;
  } = {},
) {
  useNoBundledPlugins();
  const pluginDir = options.pluginDir ?? makeTempDir();
  const pluginId = options.pluginId ?? "external-chat";
  const channelId = options.channelId ?? "external-chat";
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
        channels: [channelId],
        channelEnvVars: {
          [channelId]: ["EXTERNAL_CHAT_TOKEN"],
        },
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
          resolveAccount: () => ({ accountId: "default", token: "configured" }),
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
    id: ${JSON.stringify(channelId)},
    meta: {
      id: ${JSON.stringify(channelId)},
      label: "External Chat",
      selectionLabel: "External Chat",
      docsPath: ${JSON.stringify(`/channels/${channelId}`)},
      blurb: "setup entry",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ accountId: "default", token: "configured" }),
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
};`,
      "utf-8",
    );
  }

  return { pluginDir, fullMarker, setupMarker };
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("listReadOnlyChannelPluginsForConfig", () => {
  it("loads configured external channel setup metadata without importing full runtime", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin();
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(
      plugin?.secrets?.secretTargetRegistryEntries?.some(
        (entry) => entry.id === "channels.external-chat.token",
      ),
    ).toBe(true);
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("keeps configured external channels visible when no setup entry exists", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      setupEntry: false,
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin).toBeUndefined();
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("uses external channel env vars as read-only configuration triggers", () => {
    const { pluginDir, fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        plugins: {
          load: { paths: [pluginDir] },
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env, EXTERNAL_CHAT_TOKEN: "configured" },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(
      plugin?.secrets?.secretTargetRegistryEntries?.some(
        (entry) => entry.id === "channels.external-chat.token",
      ),
    ).toBe(true);
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });

  it("discovers trusted external channel plugins from the default agent workspace", () => {
    const workspaceDir = makeTempDir();
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "external-chat-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    const { fullMarker, setupMarker } = writeExternalSetupChannelPlugin({
      pluginDir,
      pluginId: "external-chat-plugin",
      channelId: "external-chat",
    });
    const plugins = listReadOnlyChannelPluginsForConfig(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        channels: {
          "external-chat": { token: "configured" },
        },
        plugins: {
          allow: ["external-chat-plugin"],
        },
      } as never,
      {
        env: { ...process.env },
        includePersistedAuthState: false,
      },
    );

    const plugin = plugins.find((entry) => entry.id === "external-chat");
    expect(plugin?.meta.blurb).toBe("setup entry");
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.existsSync(fullMarker)).toBe(false);
  });
});
