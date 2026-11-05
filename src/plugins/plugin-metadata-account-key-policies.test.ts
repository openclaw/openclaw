import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("channel account-key metadata ownership", () => {
  it.each([
    { firstEnabled: true, secondEnabled: true },
    { firstEnabled: false, secondEnabled: true },
    { firstEnabled: false, secondEnabled: false },
  ])(
    "loadPluginMetadataSnapshot preserves maintenance policy with enabled-owner precedence ($firstEnabled, $secondEnabled)",
    ({ firstEnabled, secondEnabled }) => {
      const selectedFirst = firstEnabled || !secondEnabled;
      const rootDir = makeTrackedTempDir("openclaw-account-policy-", tempDirs);
      const plugins = ["first", "second"].map((pluginId) => {
        const pluginRoot = path.join(rootDir, pluginId);
        fs.mkdirSync(pluginRoot);
        return createColdPluginFixture({
          rootDir: pluginRoot,
          pluginId,
          packageName: `@example/${pluginId}`,
          channelId: "selected",
          manifest: {
            providers: [],
            providerAuthChoices: [],
            channels: ["selected", "inherited"],
            channelAccountKeyPolicies: {
              selected: { canonicalAliasesRequireOwnField: pluginId },
              ...(pluginId === "second"
                ? { inherited: { canonicalAliasesRequireOwnField: "second" } }
                : {}),
            },
          },
        });
      });
      withPluginCache(createPluginCache(), () => {
        const snapshot = loadPluginMetadataSnapshot({
          config: {
            plugins: {
              load: { paths: plugins.map((plugin) => plugin.rootDir) },
              entries: { first: { enabled: firstEnabled }, second: { enabled: secondEnabled } },
            },
          },
          env: {
            ...process.env,
            OPENCLAW_HOME: rootDir,
            OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
          allowCurrent: false,
        });
        expect(snapshot.owners.channels.get("selected")).toEqual(["first", "second"]);
        expect(snapshot.owners.channelAccountKeyPolicies?.get("selected")).toEqual({
          canonicalAliasesRequireOwnField: selectedFirst ? "first" : "second",
        });
        expect(snapshot.owners.channelAccountKeyPolicies?.has("inherited")).toBe(!selectedFirst);
        const projected = projectPluginMetadataSnapshot(snapshot, ["second"]);
        expect(projected.owners.channelAccountKeyPolicies?.get("inherited")).toEqual({
          canonicalAliasesRequireOwnField: "second",
        });
        expect(
          projectPluginMetadataSnapshot(snapshot, []).owners.channelAccountKeyPolicies?.size,
        ).toBe(0);
        expect(plugins.some((plugin) => fs.existsSync(plugin.runtimeMarker))).toBe(false);
      });
    },
  );
});
