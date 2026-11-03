import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestModelDefinition } from "../commands/test-runtime-config-helpers.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { normalizeConfigMutationModelRefs } from "./config-cli-model-normalization.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    clearPluginMetadataLifecycleCaches();
    cleanup();
  }),
);

function writeProviderPlugin(root: string, prefix: string) {
  const id = `${prefix}-normalizer`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.js"), "throw new Error('metadata only');\n");
  const files = {
    "package.json": { name: id, openclaw: { extensions: ["./index.js"] } },
    "openclaw.plugin.json": {
      id,
      providers: ["custom"],
      configSchema: { type: "object" },
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "stable" }, prefixWhenBare: prefix } },
      },
    },
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), JSON.stringify(content));
  }
}

it("preserves global provider policies across workspace changes without executing plugins", async () => {
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
          models: [createTestModelDefinition("latest", { name: "Latest" })],
        },
      },
    },
  };
  await withPluginCache(createPluginCache(), async () => {
    const pluginMetadataSnapshot = await resolveConfigWidePluginMetadataSnapshotAsync({
      config: baseConfig,
      env,
      installRecords: {},
      allowCurrent: false,
    });
    expect(
      pluginMetadataSnapshot.owners.modelIdNormalizationPolicies.get("custom")?.prefixWhenBare,
    ).toBe("old");
    const options = { pluginMetadataSnapshot, env };
    for (const workspace of [previous, next]) {
      const config = {
        ...baseConfig,
        agents: { entries: { ...baseConfig.agents?.entries, secondary: { workspace } } },
      };
      const normalized = await normalizeConfigMutationModelRefs(config, options);
      expect(normalized.models?.providers?.custom?.models[0]?.id).toBe("global/stable");
    }
  });
});
