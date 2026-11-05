import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  clearActiveDegradedPlugin,
  findActiveDegradedPlugin,
  listActiveDegradedPlugins,
  pluginInstallPathMatchesRoot,
  setActiveDegradedPlugins,
} from "./runtime-degraded-state.js";

describe("pluginInstallPathMatchesRoot", () => {
  it("matches an existing plugin root through a symlink alias", () => {
    if (process.platform === "win32") {
      return;
    }

    withTempDirSync({ prefix: "openclaw-degraded-plugin-root-" }, (baseDir) => {
      const pluginRoot = path.join(baseDir, "plugin");
      const pluginAlias = path.join(baseDir, "plugin-alias");
      fs.mkdirSync(pluginRoot);
      fs.symlinkSync(pluginRoot, pluginAlias, "dir");

      expect(pluginInstallPathMatchesRoot(pluginAlias, pluginRoot)).toBe(true);
    });
  });

  it("falls back to absolute lexical paths when plugin roots are missing", () => {
    withTempDirSync({ prefix: "openclaw-degraded-plugin-root-" }, (baseDir) => {
      const missingRoot = path.join(baseDir, "missing-plugin");
      const equivalentMissingRoot = path.join(baseDir, "nested", "..", "missing-plugin");

      expect(pluginInstallPathMatchesRoot(equivalentMissingRoot, missingRoot)).toBe(true);
      expect(pluginInstallPathMatchesRoot(path.join(baseDir, "other-missing"), missingRoot)).toBe(
        false,
      );
    });
  });
});

it("keeps quarantine snapshots stable across caller edits, replacement, and clearing", () => {
  const previous = listActiveDegradedPlugins();
  try {
    const plugins = buildDegradedPluginsFromVerificationFailures([
      { pluginId: "example", reason: "missing-package-json", detail: "package.json is missing" },
    ]);
    setActiveDegradedPlugins(plugins);
    const snapshot = listActiveDegradedPlugins();

    plugins.length = 0;
    expect(listActiveDegradedPlugins()).toHaveLength(1);

    setActiveDegradedPlugins(
      buildDegradedPluginsFromVerificationFailures([
        { pluginId: "example", reason: "missing-main-entry", detail: "main entry is missing" },
      ]),
    );
    expect(findActiveDegradedPlugin("example")?.diagnostic.reason).toBe("missing-main-entry");
    expect(snapshot.map((plugin) => plugin.diagnostic.reason)).toEqual(["missing-package-json"]);

    clearActiveDegradedPlugin("example");
    expect(findActiveDegradedPlugin("example")).toBeUndefined();
    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(snapshot.map((plugin) => plugin.diagnostic.reason)).toEqual(["missing-package-json"]);
  } finally {
    setActiveDegradedPlugins(previous);
  }
});
