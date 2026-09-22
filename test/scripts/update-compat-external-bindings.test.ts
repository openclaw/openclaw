import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();
const chunk = previousReleaseInventory.releases[0]!.chunks.find((entry) =>
  /-[A-Za-z0-9_-]{8}\.m?js$/.test(entry.path),
)!;
const externalSources = [
  { kind: "named export", source: 'export { helper as NAME } from "external-package";' },
  { kind: "namespace export", source: 'export * as NAME from "external-package";' },
  {
    kind: "namespace import",
    source: 'import * as NAME from "external-package"; export { NAME };',
  },
];

it.each([
  'import { safePath as helper } from "@openclaw/fs-safe/path"; export { helper };',
  'import helper from "external-package"; export { helper };',
  'export { safePath as helper } from "@openclaw/fs-safe/path";',
  'import { basename as helper } from "node:path"; export { helper };',
  'export * as helper from "external-package";',
  'import * as helper from "external-package"; export { helper };',
])("keeps published updater bridges usable beside %s", async (external) => {
  const root = createTempDir("update-compat-external-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeUpdateCompatibilityBuildFixture(root);
  fs.writeFileSync(
    path.join(root, "dist/unrelated-worker.mjs"),
    `//#region ${chunk.exports[0]!.origin.module}\n${external}\n`,
  );
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

it.each(externalSources)(
  "refuses a required updater implementation replaced with an external $kind",
  ({ source: template }) => {
    const root = createTempDir("update-compat-required-external-");
    writeUpdateCompatibilityBuildFixture(root);
    const origin = chunk.exports[0]!.origin;
    const source = path.join(root, origin.module);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, `${template.replaceAll("NAME", origin.symbol)}\n`);
    expect(() =>
      writeUpdateCompatibilityChunks({
        distDir: path.join(root, "dist"),
        sourceDir: root,
        inventory: previousReleaseInventory,
      }),
    ).toThrow("Cannot resolve current source binding");
    expect(fs.existsSync(path.join(root, "dist/update-compat-inventory.json"))).toBe(false);
  },
);

it.each(externalSources)("refuses to omit a published external $kind", ({ source }) => {
  const root = createTempDir("update-compat-published-external-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
  );
  fs.writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.9.1", buildId: "fixture", commit: "0".repeat(40) }),
  );
  fs.writeFileSync(
    path.join(root, "dist/command.mjs"),
    '//#region src/cli/update-cli/update-command-service-command.ts\nexport async function restart() { return await import("./surface-abcdefgh.mjs"); }\n',
  );
  fs.writeFileSync(
    path.join(root, "dist/surface-abcdefgh.mjs"),
    `//#region src/infra/value.ts\nexport const owned = 1;\n${source.replaceAll("NAME", "external")}\n`,
  );
  expect(() =>
    recordUpdateCompatibilityRelease({
      packageDir: root,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    }),
  ).toThrow("Cannot trace surface-abcdefgh.mjs export external to its release source");
});
