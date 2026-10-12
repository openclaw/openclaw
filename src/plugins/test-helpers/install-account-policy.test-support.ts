import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import { createColdPluginFixture } from "./cold-plugin-fixtures.js";

export function createInstallAccountPolicyFixture(rootDir: string, channelId: string) {
  const pluginRoot = path.join(rootDir, "plugin");
  fs.mkdirSync(pluginRoot);
  const manifest = {
    id: channelId,
    channels: [channelId],
    providers: [],
    providerAuthChoices: [],
    configSchema: { type: "object" },
    channelConfigs: { [channelId]: { schema: { type: "object" } } },
  };
  createColdPluginFixture({ rootDir: pluginRoot, pluginId: channelId, channelId, manifest });
  const config: OpenClawConfig = {
    plugins: {
      load: { paths: [pluginRoot] },
      entries: { [channelId]: { enabled: true } },
    },
    channels: {
      [channelId]: {
        accounts: { "Work Phone": { account: "+12025550123", name: "Old name" } },
      },
    },
  };
  const env = {
    ...process.env,
    OPENCLAW_HOME: rootDir,
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  return {
    config,
    env,
    readMetadata(currentConfig = config, workspaceDir?: string) {
      return loadPluginMetadataSnapshot({
        config: currentConfig,
        workspaceDir,
        env,
        allowCurrent: false,
        preferPersisted: false,
      });
    },
    installPolicy() {
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          ...manifest,
          channelAccountKeyPolicies: {
            [channelId]: { canonicalAliasesRequireOwnField: "account" },
          },
        }),
      );
      clearPluginMetadataLifecycleCaches();
    },
  };
}
