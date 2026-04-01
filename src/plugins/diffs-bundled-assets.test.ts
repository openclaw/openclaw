import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const diffsPluginIndexPath = path.join(repoRoot, "dist/extensions/diffs/index.js");
const viewerRuntimePath = path.join(repoRoot, "dist/extensions/assets/viewer-runtime.js");

describe("bundled diffs viewer assets", () => {
  test("references the shipped viewer runtime asset from the bundled diffs plugin", async () => {
    const pluginIndex = await fs.readFile(diffsPluginIndexPath, "utf8");

    expect(pluginIndex).toContain("../assets/viewer-runtime.js");
    expect(pluginIndex).toContain('import "${VIEWER_RUNTIME_RELATIVE_IMPORT_PATH}?v=${hash}";');
  });

  test("ships the expected viewer runtime asset", async () => {
    const viewerRuntime = await fs.readFile(viewerRuntimePath, "utf8");

    expect(viewerRuntime).toContain('const DIFFS_TAG_NAME = "diffs-container";');
    expect(viewerRuntime).toContain('shadowrootmode="open"');
    expect(viewerRuntime).toContain(
      'document.documentElement.dataset.openclawDiffsReady = "true";',
    );
  });
});
