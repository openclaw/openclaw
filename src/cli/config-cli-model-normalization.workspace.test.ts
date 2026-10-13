import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { normalizeConfigMutationModelRefs } from "./config-cli-model-normalization.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    cleanup();
  }),
);

function writeProviderPlugin(root: string, prefix: string) {
  const id = `${prefix}-normalizer`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.js"), "throw new Error('metadata only');\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: id, openclaw: { extensions: ["./index.js"] } }),
  );
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      providers: ["custom"],
      configSchema: { type: "object" },
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "stable" }, prefixWhenBare: prefix } },
      },
    }),
  );
}

it("preserves global provider policies across workspace changes without executing plugins", () => {
  const home = dirs.make("config-model-workspaces-");
  const previous = path.join(home, "previous");
  const next = path.join(home, "next");
  const env = {
    HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  writeProviderPlugin(path.join(resolveDefaultPluginExtensionsDir(env), "normalizer"), "global");
  writeProviderPlugin(path.join(previous, ".openclaw/extensions/normalizer"), "old");
  writeProviderPlugin(path.join(next, ".openclaw/extensions/normalizer"), "new");
  const baseConfig: OpenClawConfig = {
    agents: {
      entries: {
        main: { workspace: path.join(home, "main") },
        secondary: { workspace: previous },
      },
    },
    models: {
      providers: {
        custom: {
          baseUrl: "https://example.test",
          models: [
            {
              id: "latest",
              name: "Latest",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
  withPluginCache(createPluginCache(), () => {
    const pluginMetadataSnapshot = resolveConfigWidePluginMetadataSnapshot({
      config: baseConfig,
      env,
      installRecords: {},
      allowCurrent: false,
    });
    expect(
      pluginMetadataSnapshot.owners.modelIdNormalizationPolicies.get("custom")?.prefixWhenBare,
    ).toBe("old");
    const options = { pluginMetadataSnapshot, env };
    expect(
      normalizeConfigMutationModelRefs(baseConfig, options).models?.providers?.custom?.models[0]
        ?.id,
    ).toBe("global/stable");
    const config: OpenClawConfig = {
      ...baseConfig,
      agents: { entries: { ...baseConfig.agents?.entries, secondary: { workspace: next } } },
    };
    expect(
      normalizeConfigMutationModelRefs(config, options).models?.providers?.custom?.models[0]?.id,
    ).toBe("global/stable");
  });
});
