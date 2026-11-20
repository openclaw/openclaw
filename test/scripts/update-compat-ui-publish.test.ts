import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { writeUpdateCompatibilityChunks } from "../../scripts/lib/update-compat-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();

it("keeps updater bridges usable while the independent Control UI build is published", async () => {
  const root = createTempDir("update-compat-ui-publish-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeUpdateCompatibilityBuildFixture(root);
  const dist = path.join(root, "dist");
  const output = path.join(dist, "control-ui");
  const staging = path.join(dist, "control-ui.build-1234-fixture");
  const retired = `${staging}.retired`;
  for (const directory of [output, staging, retired]) {
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(directory, "assets/browser.js"), 'export const label = "Browser";');
  }
  let published = false;
  const originalRead = fs.readFileSync;
  const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if (file === path.join(dist, "candidate-0.mjs") && !published) {
      // Publish after the runtime owner has collected its module paths, as in build-all.
      fs.rmSync(retired, { recursive: true });
      fs.renameSync(output, retired);
      fs.renameSync(staging, output);
      fs.rmSync(retired, { recursive: true });
      published = true;
    }
    return originalRead(file, options);
  });
  try {
    writeUpdateCompatibilityChunks({
      distDir: dist,
      sourceDir: root,
      inventory: previousReleaseInventory,
    });
  } finally {
    read.mockRestore();
  }
  expect(published).toBe(true);
  const chunk = previousReleaseInventory.releases[0]!.chunks.find((entry) =>
    /-[A-Za-z0-9_-]{8}\.m?js$/.test(entry.path),
  )!;
  const legacy = await import(pathToFileURL(path.join(dist, chunk.path)).href);
  for (const { exported, origin } of chunk.exports) {
    expect(await legacy[exported]()).toBe(origin.symbol);
  }
});
