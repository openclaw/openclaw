import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";

vi.unmock("../version.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("installed plugin index context engine ownership", () => {
  it("projects engine ownership from manifests without importing runtime code", () => {
    const fixture = createColdPluginFixture({
      rootDir: tempDirs.make("openclaw-installed-plugin-index-engine-"),
      pluginId: "vendor-plugin",
      manifest: {
        kind: "context-engine",
        contextEngineIds: ["canonical-engine"],
        configSchema: {},
      },
    });
    const index = loadInstalledPluginIndex({
      candidates: [
        {
          idHint: fixture.pluginId,
          rootDir: fixture.rootDir,
          source: fixture.runtimeSource,
          origin: "global",
        },
      ],
      installRecords: {},
      env: {
        OPENCLAW_HOME: fixture.rootDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
    });
    expect(index.plugins[0]?.contextEngineIds).toEqual(["canonical-engine"]);
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });
});
