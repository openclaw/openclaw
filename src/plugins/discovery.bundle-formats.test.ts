import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverOpenClawPlugins } from "./discovery.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTrackedTempDirs(tempDirs));

it.each([
  [
    "agent",
    "portable-bundle",
    "plugin.json",
    "skills/sample",
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "portable-bundle",
    },
  ],
  ["claude", "claude-bundle", "settings.json", "commands", { hideThinkingBlock: true }],
  [
    "cursor",
    "cursor-bundle",
    ".cursor-plugin/plugin.json",
    ".cursor/commands",
    { name: "Cursor Bundle" },
  ],
] as const)(
  "discovers %s bundles from their metadata and default layout",
  (format, id, marker, directory, manifest) => {
    const root = makeTrackedTempDir("openclaw-bundle-formats", tempDirs);
    const bundleDir = path.join(root, "extensions", id);
    const markerPath = path.join(bundleDir, marker);
    mkdirSafeDir(path.dirname(markerPath));
    fs.writeFileSync(markerPath, JSON.stringify(manifest), "utf-8");
    mkdirSafeDir(path.join(bundleDir, directory));
    const { candidates } = withPluginCache(createPluginCache(), () =>
      discoverOpenClawPlugins({
        env: {
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_HOME: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      }),
    );
    expect(candidates.find((candidate) => candidate.idHint === id)).toMatchObject({
      idHint: id,
      format: "bundle",
      bundleFormat: format,
      source: bundleDir,
      rootDir: fs.realpathSync(bundleDir),
    });
  },
);
