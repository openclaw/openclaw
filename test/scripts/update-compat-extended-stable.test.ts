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

it("resolves the published lease dispatch through its extracted operation owner", async () => {
  const release = previousReleaseInventory.releases.find(({ version }) => version === "2026.9.36")!;
  const chunk = release.chunks.find(({ exports }) =>
    exports.some(({ origin }) => origin.symbol === "runWithOpenClawStateLeaseWorker"),
  )!;
  const root = createTempDir("update-compat-lease-operation-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const owner = "src/state/openclaw-state-lease-worker-operation.ts";
  const previous = "src/state/openclaw-state-lease-worker-storage.ts";
  for (const file of [owner, previous]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(new URL("../../" + file, import.meta.url), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "dist/current-lease.mjs"),
    `//#region ${owner}
export function runWithOpenClawStateLeaseWorker() { return "current lease owner"; }
`,
  );
  writeUpdateCompatibilityChunks({
    distDir: path.join(root, "dist"),
    sourceDir: root,
    inventory: { schemaVersion: 1, releases: [{ ...release, chunks: [chunk] }] },
  });
  const legacy = await import(pathToFileURL(path.join(root, "dist", chunk.path)).href);
  expect(legacy.runWithOpenClawStateLeaseWorker()).toBe("current lease owner");
});

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
