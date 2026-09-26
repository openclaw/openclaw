import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

it("checks shared persisted files once per fleet while discovering every workspace and refreshing the next operation", async () => {
  const root = tempDirs.make("openclaw-fleet-plugin-registry-");
  const bundled = path.join(root, "bundled");
  const sharedRoot = path.join(bundled, "shared");
  fs.mkdirSync(sharedRoot, { recursive: true });
  const shared = createColdPluginFixture({ rootDir: sharedRoot, pluginId: "shared" });
  const workspaces = Array.from({ length: 6 }, (_, index) => path.join(root, `agent-${index}`));
  for (const [index, workspace] of workspaces.entries()) {
    const localRoot = path.join(workspace, ".openclaw", "extensions", `local-${index}`);
    fs.mkdirSync(localRoot, { recursive: true });
    createColdPluginFixture({ rootDir: localRoot, pluginId: `local-${index}` });
  }
  const env = {
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
  const configFor = (count: number) => ({
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        workspaces.slice(0, count).map((workspace, index) => [`agent-${index}`, { workspace }]),
      ),
    },
  });
  await writePersistedInstalledPluginIndex(
    loadInstalledPluginIndex({ config: configFor(3), env, workspaceDir: workspaces[0] }),
    { env },
  );
  const manifestPath = path.join(sharedRoot, "openclaw.plugin.json");
  const readFleet = (count: number) => {
    const inspectPath = vi.spyOn(fs, "lstatSync");
    try {
      const snapshot = resolveConfigWidePluginMetadataSnapshot({
        config: configFor(count),
        env,
        allowCurrent: false,
      });
      expect(snapshot.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
        ["shared", ...workspaces.slice(0, count).map((_, index) => `local-${index}`)].toSorted(),
      );
      expect(snapshot.registryIndex.workspaceDir).toBe(workspaces[0]);
      expect(snapshot.plugins.find((plugin) => plugin.id === `local-${count - 1}`)?.source).toBe(
        path.join(
          root,
          `agent-${count - 1}`,
          ".openclaw",
          "extensions",
          `local-${count - 1}`,
          "index.cjs",
        ),
      );
      return {
        snapshot,
        sharedFileChecks: inspectPath.mock.calls.filter(([target]) => target === manifestPath)
          .length,
      };
    } finally {
      inspectPath.mockRestore();
    }
  };
  const small = readFleet(3);
  const large = readFleet(6);
  expect(small.sharedFileChecks).toBeGreaterThan(0);
  expect(large.sharedFileChecks).toBe(small.sharedFileChecks);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "shared",
      name: "Updated fleet plugin",
      configSchema: { type: "object" },
    }),
  );
  expect(readFleet(6).snapshot.byPluginId.get("shared")?.name).toBe("Updated fleet plugin");
  expect(large.snapshot.byPluginId.get("shared")?.name).toBe("Cold Control Plane");
  expect(fs.existsSync(shared.runtimeMarker)).toBe(false);
});
