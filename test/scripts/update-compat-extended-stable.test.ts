import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { writeUpdateCompatibilityChunks } from "../../scripts/lib/update-compat-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();

it("bridges the published 2026.9.36 deferred-migration import after package replacement", async () => {
  const release = previousReleaseInventory.releases.find(({ version }) => version === "2026.9.36");
  const chunk = release?.chunks.find(
    ({ path: file }) => file === "openclaw-state-worker-store-BZtiP8dt.mjs",
  );
  expect(
    chunk,
    "the shipped updater imports this old hash after activating its target",
  ).toBeDefined();
  if (!chunk) {
    throw new Error("Missing published 2026.9.36 state-worker compatibility chunk");
  }
  expect(chunk.imports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ owner: "src/infra/deferred-plugin-migrations.ts" }),
    ]),
  );
  const root = createTempDir("update-compat-extended-stable-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeUpdateCompatibilityBuildFixture(root);
  writeUpdateCompatibilityChunks({
    distDir: path.join(root, "dist"),
    sourceDir: root,
    inventory: previousReleaseInventory,
  });
  const legacy = await import(pathToFileURL(path.join(root, "dist", chunk.path)).href);
  for (const { exported, origin } of chunk.exports) {
    expect(legacy[exported]()).toBe(origin.symbol);
  }
});
