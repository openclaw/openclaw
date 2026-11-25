import fs from "node:fs";
import { expect, it } from "vitest";
import {
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { fixtureFiles } from "./script-fixture-files.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();
const deferredOwner = "src/infra/deferred-plugin-migrations.ts";

it("records and bridges a deferred migration first imported after package replacement", async () => {
  const f = fixtureFiles(createTempDir("update-compat-deferred-"));
  f.json("package.json", { name: "openclaw", version: "2026.9.36", type: "module" });
  f.json("dist/build-info.json", {
    version: "2026.9.36",
    buildId: "fixture",
    commit: "0".repeat(40),
  });
  f.write(
    "dist/deferred.mjs",
    [
      "//#region " + deferredOwner,
      'export async function migrate() { const { run: migrate } = await import("./worker-abcdefgh.mjs"); return migrate(); }',
    ].join("\n"),
  );
  f.write(
    "dist/worker-abcdefgh.mjs",
    [
      "//#region src/state/migration-worker.ts",
      'export function run() { return "old"; }',
      "export function unused() {}",
    ].join("\n"),
  );
  const release = recordUpdateCompatibilityRelease({
    packageDir: f.root,
    integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
  });
  expect(release.chunks).toEqual([
    {
      path: "worker-abcdefgh.mjs",
      imports: [{ importer: "deferred.mjs", owner: deferredOwner, exports: ["run"] }],
      exports: [
        { exported: "run", origin: { module: "src/state/migration-worker.ts", symbol: "run" } },
      ],
    },
  ]);
  const { migrate } = await f.load("dist/deferred.mjs");
  fs.unlinkSync(f.file("dist/worker-abcdefgh.mjs"));
  f.write(
    "dist/current.mjs",
    ["//#region src/state/migration-worker.ts", 'export function run() { return "new"; }'].join(
      "\n",
    ),
  );
  writeUpdateCompatibilityChunks({
    distDir: f.file("dist"),
    sourceDir: f.root,
    inventory: { schemaVersion: 1, releases: [release] },
  });
  expect(await migrate()).toBe("new");
});

it("resolves the historical lease dispatch without restoring the storage export", async () => {
  const f = fixtureFiles(createTempDir("update-compat-lease-operation-"));
  f.json("package.json", { type: "module" });
  const owner = "src/state/openclaw-state-lease-worker-operation.ts";
  const previous = "src/state/openclaw-state-lease-worker-storage.ts";
  for (const file of [owner, previous]) {
    f.write(file, fs.readFileSync(new URL("../../" + file, import.meta.url), "utf8"));
  }
  f.write(
    "dist/current.mjs",
    [
      "//#region " + owner,
      'export function runWithOpenClawStateLeaseWorker() { return "current lease owner"; }',
    ].join("\n"),
  );
  writeUpdateCompatibilityChunks({
    distDir: f.file("dist"),
    sourceDir: f.root,
    inventory: {
      schemaVersion: 1,
      releases: [
        {
          version: "2026.9.36",
          buildId: "fixture",
          commit: "0".repeat(40),
          integrity: "sha512-fixture",
          chunks: [
            {
              path: "lease-abcdefgh.mjs",
              imports: [
                {
                  importer: "deferred.mjs",
                  owner: deferredOwner,
                  exports: ["runWithOpenClawStateLeaseWorker"],
                },
              ],
              exports: [
                {
                  exported: "runWithOpenClawStateLeaseWorker",
                  origin: { module: previous, symbol: "runWithOpenClawStateLeaseWorker" },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const legacy = await f.load("dist/lease-abcdefgh.mjs");
  expect(legacy.runWithOpenClawStateLeaseWorker()).toBe("current lease owner");
});

it.each<[string, string[]]>([
  ["2026.9.36", ["openclaw-state-worker-store-BZtiP8dt.mjs"]],
  [
    "2026.10.33",
    [
      "openclaw-state-lease-worker-operation-B_XyhbNh.mjs",
      "openclaw-state-worker-store-B3uQGpcH.mjs",
      "plugin-lifecycle-lease-D1DZ0UMr.mjs",
    ],
  ],
  [
    "2026.11.6",
    [
      "openclaw-state-lease-worker-operation-BhGpcgHT.mjs",
      "openclaw-state-worker-store-B_SHxTga.mjs",
      "plugin-lifecycle-lease-SmNg_dIh.mjs",
    ],
  ],
])("bridges the published %s deferred imports after replacement", async (version, paths) => {
  const release = previousReleaseInventory.releases.find((entry) => entry.version === version);
  expect(release, "published first-hop release must remain supported").toBeDefined();
  const chunks = paths.map((file) => {
    const chunk = release?.chunks.find((entry) => entry.path === file);
    expect(chunk, "published late-import hash must remain resolvable").toBeDefined();
    if (!chunk) {
      throw new Error("Missing published " + version + " chunk " + file);
    }
    expect(chunk.imports).toEqual(
      expect.arrayContaining([expect.objectContaining({ owner: deferredOwner })]),
    );
    return chunk;
  });
  const f = fixtureFiles(createTempDir("update-compat-published-deferred-"));
  f.json("package.json", { type: "module" });
  writeUpdateCompatibilityBuildFixture(f.root);
  if (!release) {
    throw new Error("Missing release " + version);
  }
  writeUpdateCompatibilityChunks({
    distDir: f.file("dist"),
    sourceDir: f.root,
    inventory: { schemaVersion: 1, releases: [{ ...release, chunks }] },
  });
  for (const chunk of chunks) {
    const legacy = await f.load("dist/" + chunk.path);
    for (const { exported, origin } of chunk.exports) {
      expect(legacy[exported]()).toBe(origin.symbol);
    }
  }
});
