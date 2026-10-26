import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { channelFixtureSource } from "./loader-fixture-builders.test-support.js";
import { clearPluginLoaderCache, loadOpenClawPlugins } from "./loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { makeTrackedTempDir, mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makePluginLoaderTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-prefer-over", tempDirs);
}

function writeChannelToolPlugin(params: {
  rootDir: string;
  id: string;
  enabledByDefault?: boolean;
  preferOver?: string[];
  canonicalAliasesRequireOwnField?: string;
}): string {
  const channelId = "qqbot";
  const pluginDir = path.join(params.rootDir, params.id);
  mkdirSafeDir(pluginDir);
  writeArtifacts(pluginDir, {
    "openclaw.plugin.json": {
      id: params.id,
      channels: [channelId],
      ...(params.canonicalAliasesRequireOwnField
        ? {
            channelAccountKeyPolicies: {
              [channelId]: {
                canonicalAliasesRequireOwnField: params.canonicalAliasesRequireOwnField,
              },
            },
          }
        : {}),
      contracts: { tools: ["qqbot_remind"] },
      ...(params.enabledByDefault ? { enabledByDefault: true } : {}),
      channelConfigs: {
        [channelId]: {
          schema: { type: "object" },
          ...(params.preferOver ? { preferOver: params.preferOver } : {}),
        },
      },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    "index.cjs": `module.exports = {
      id: ${JSON.stringify(params.id)},
      register(api) {
        api.registerChannel({ plugin: ${channelFixtureSource(channelId, { label: channelId, docsPath: "/channels/qqbot" })} });
        api.registerTool({
          name: "qqbot_remind",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { name: "qqbot_remind" });
      },
    };`,
  });
  return pluginDir;
}

afterEach(() => {
  clearPluginLoaderCache();
  resetPluginRuntimeStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(preferred = false, canonicalAliasesRequireOwnField?: string) {
  const bundledRoot = makePluginLoaderTempDir();
  writeChannelToolPlugin({
    rootDir: bundledRoot,
    id: "qqbot",
    enabledByDefault: true,
    canonicalAliasesRequireOwnField: preferred ? "retired" : undefined,
  });
  const externalPluginDir = writeChannelToolPlugin({
    rootDir: makePluginLoaderTempDir(),
    id: "openclaw-qqbot",
    preferOver: preferred ? ["qqbot"] : undefined,
    canonicalAliasesRequireOwnField,
  });
  const env = {
    OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
  };
  const config = {
    channels: { qqbot: { appId: "app", clientSecret: "secret" } },
    plugins: { load: { paths: [externalPluginDir] } },
  };
  return { env, config };
}

describe("plugin loader preferOver activation", () => {
  it.each([undefined, "replacement"])(
    "loadPluginMetadataSnapshot and loadOpenClawPlugins select the preferred channel policy (%s)",
    (canonicalAliasesRequireOwnField) => {
      const { env, config: rawConfig } = fixture(true, canonicalAliasesRequireOwnField);
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

      expect(autoEnabled.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
      expect(autoEnabled.config.plugins?.entries?.qqbot?.enabled).toBe(false);
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
    const { env, config } = fixture();

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
});
