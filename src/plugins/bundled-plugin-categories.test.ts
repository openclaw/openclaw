// Keeps every bundled plugin assigned to the package-owned catalog taxonomy.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_CATEGORY_SLUGS } from "../../packages/plugin-package-contract/src/index.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import { loadPluginManifest } from "./manifest.js";

describe("bundled plugin categories", () => {
  it("assigns active categories to every bundled plugin", () => {
    const extensionsRoot = path.join(repoRoot, "extensions");
    const missing: string[] = [];
    const invalid: string[] = [];
    let manifestCount = 0;

    for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(extensionsRoot, entry.name, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      manifestCount += 1;
      const result = loadPluginManifest(path.dirname(manifestPath), false);
      if (!result.ok) {
        invalid.push(`${entry.name}: ${result.error}`);
        continue;
      }
      if (!result.manifest.categories?.length) {
        missing.push(entry.name);
      }
      for (const category of result.manifest.categories ?? []) {
        if (!PLUGIN_CATEGORY_SLUGS.some((activeCategory) => activeCategory === category)) {
          invalid.push(`${entry.name}: retired category ${category}`);
        }
      }
    }

    expect(manifestCount).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
    expect(missing).toEqual([]);
  });
});
