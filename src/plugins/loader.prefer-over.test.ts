import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { channelFixtureSource, writeFixtureJson } from "./loader-fixture-builders.test-support.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  mkdirSafe,
} from "./loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

function writeChannelToolPlugin({
  rootDir,
  id,
  enabledByDefault,
  preferOver,
  canonicalAliasesRequireOwnField,
}: {
  rootDir: string;
  id: string;
  enabledByDefault?: boolean;
  preferOver?: string[];
  canonicalAliasesRequireOwnField?: string;
}): string {
  const pluginDir = path.join(rootDir, id);
  mkdirSafe(pluginDir);
  writeFixtureJson(pluginDir, "openclaw.plugin.json", {
    id,
    channels: ["qqbot"],
    channelAccountKeyPolicies: canonicalAliasesRequireOwnField
      ? { qqbot: { canonicalAliasesRequireOwnField } }
      : undefined,
    contracts: { tools: ["qqbot_remind"] },
    enabledByDefault,
    channelConfigs: {
      qqbot: { schema: { type: "object" }, preferOver },
    },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: ${JSON.stringify(id)},
      register(api) {
        api.registerChannel({ plugin: ${channelFixtureSource("qqbot")} });
        api.registerTool({
          name: "qqbot_remind",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { name: "qqbot_remind" });
      },
    };`,
    "utf-8",
  );
  return pluginDir;
}

afterEach(() => {
  clearPluginLoaderCache();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function channelPair(preferOver?: string[], canonicalAliasesRequireOwnField?: string) {
  const bundledRoot = makePluginLoaderTempDir();
  writeChannelToolPlugin({
    rootDir: bundledRoot,
    id: "qqbot",
    enabledByDefault: true,
    canonicalAliasesRequireOwnField: preferOver ? "retired" : undefined,
  });
  const externalPluginDir = writeChannelToolPlugin({
    rootDir: makePluginLoaderTempDir(),
    id: "openclaw-qqbot",
    preferOver,
    canonicalAliasesRequireOwnField,
  });
  return {
    env: {
      OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    },
    config: {
      channels: { qqbot: { appId: "app", clientSecret: "secret" } },
      plugins: { load: { paths: [externalPluginDir] } },
    },
  };
}

it.each([undefined, "replacement"])(
  "loadPluginMetadataSnapshot and loadOpenClawPlugins select the preferred channel policy (%s)",
  (canonicalAliasesRequireOwnField) => {
    const { env, config: rawConfig } = channelPair(["qqbot"], canonicalAliasesRequireOwnField);
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });
    const metadata = loadPluginMetadataSnapshot({ config: autoEnabled.config, env });
    expect(metadata.owners.channelAccountKeyPolicies?.get("qqbot")).toEqual(
      canonicalAliasesRequireOwnField ? { canonicalAliasesRequireOwnField } : undefined,
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: autoEnabled.config,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      env,
    });

    expect(autoEnabled.config.plugins?.entries).toMatchObject({
      "openclaw-qqbot": { enabled: true },
      qqbot: { enabled: false },
    });
    expect(registry.plugins.find((plugin) => plugin.id === "openclaw-qqbot")?.status).toBe(
      "loaded",
    );
    expect(registry.plugins.find((plugin) => plugin.id === "qqbot")?.status).toBe("disabled");
    expect(registry.tools.map((tool) => tool.pluginId)).toEqual(["openclaw-qqbot"]);
    expect(registry.diagnostics.map((diag) => diag.message).join("\n")).not.toContain(
      "plugin tool name conflict",
    );
  },
);

it("blocks tools from a plugin that loses a duplicate channel registration", () => {
  const { env, config } = channelPair();
  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          qqbot: { enabled: true },
          "openclaw-qqbot": { enabled: true },
        },
      },
    },
    env,
  });

  const diagnostics = registry.diagnostics.map((diag) => diag.message).join("\n");
  expect(diagnostics).toContain("channel already registered: qqbot");
  expect(diagnostics).not.toContain("plugin tool name conflict");
  expect(registry.tools.map((tool) => tool.pluginId)).toHaveLength(1);
});
