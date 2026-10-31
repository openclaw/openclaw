import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  ISOLATED_COMPATIBILITY_BRIDGE,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();
const staticSpecifiers = (source: string) =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*"([^"]+)"/g)].map((m) => m[1]!);

// Vitest's module runner hides Node's URL-keyed ESM cache, so the updater runs natively.
const OLD_UPDATER = `
import fs from "node:fs";
const shim = await import(process.argv[2]);
await import("./old.mjs");
// Package activation replaces the dependency at the path the old updater already cached.
fs.writeFileSync("node_modules/dep/index.js", "export const a = 1;\\nexport const b = 2;\\n");
const linked = await import("./current.mjs").then(() => "linked", (error) => error.message);
class Revoked extends Error {}
const revoked = new Revoked("lost executor");
let current = true;
const fence = new (class { assertCurrent() { if (!current) throw revoked; } })();
const steps = [];
const result = { steps: ["started"] };
const recover = shim.isolatedUpdateCompatExport(import.meta.url, "./current.mjs", "recover");
// Released updaters freeze requester records; write-back must leave them alone.
const requester = Object.freeze({ isCurrent: () => true });
const same = (await recover({ onStep: (step) => steps.push(step), fence, requester, result })) === result;
current = false;
const refused = await recover({ onStep() {}, fence, requester, result: { steps: [] } }).catch((e) => e === revoked);
const run = await shim.isolatedUpdateCompatExport(import.meta.url, "./current.mjs", "prepare")();
console.log(JSON.stringify({ linked, same, steps, result, refused, doubled: await run(21) }));
`;

it("runs bridged recovery code against the replaced dependency tree, not the cached one", () => {
  const root = createTempDir("update-compat-isolated-");
  fs.mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
  const files = {
    "package.json": '{"type":"module"}',
    "node_modules/dep/package.json": '{"name":"dep","type":"module","exports":"./index.js"}',
    "node_modules/dep/index.js": "export const a = 1;\n",
    "old.mjs": 'export { a } from "dep";\n',
    "current.mjs": [
      'import { b } from "dep";',
      "export async function recover(params) {",
      "  params.onStep({ b });",
      "  params.fence.assertCurrent();",
      "  if (!params.requester.isCurrent()) throw new Error('revoked');",
      "  params.result.steps.push(`recovered ${b}`);",
      "  return params.result;",
      "}",
      "export const prepare = async () => (factor) => b * factor;",
    ].join("\n"),
    "updater.mjs": OLD_UPDATER,
  };
  for (const [file, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, file), contents);
  }
  const shim = new URL("../../scripts/lib/update-compat-isolated-bridge.mjs", import.meta.url);
  // Updaters run on Node even when this suite runs on Bun.
  const output = execFileSync("node", ["updater.mjs", shim.href], {
    cwd: root,
    encoding: "utf8",
  });
  expect(JSON.parse(output)).toEqual({
    linked: expect.stringMatching(/does not provide an export named 'b'/),
    same: true,
    steps: [{ b: 2 }],
    result: { steps: ["started", "recovered 2"] },
    refused: true,
    doubled: 42,
  });
});

it("keeps recovery bridges thin and refuses unisolated recovery imports", () => {
  const root = createTempDir("update-compat-isolated-graph-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeUpdateCompatibilityBuildFixture(root);
  const dist = path.join(root, "dist");
  const emit = (inventory = previousReleaseInventory) =>
    writeUpdateCompatibilityChunks({ distDir: dist, sourceDir: root, inventory });
  const written = emit();
  const shim = fs.readFileSync(path.join(dist, ISOLATED_COMPATIBILITY_BRIDGE), "utf8");
  expect(staticSpecifiers(shim).every((specifier) => specifier.startsWith("node:"))).toBe(true);
  const isolated = written.filter(
    (file) =>
      file !== ISOLATED_COMPATIBILITY_BRIDGE &&
      fs.readFileSync(path.join(dist, file), "utf8").includes("isolatedUpdateCompatExport("),
  );
  expect(isolated.some((file) => file.startsWith("update-command-fresh-doctor-"))).toBe(true);
  for (const file of isolated) {
    const specifiers = staticSpecifiers(fs.readFileSync(path.join(dist, file), "utf8"));
    expect(specifiers.map((specifier) => path.posix.basename(specifier))).toEqual([
      ISOLATED_COMPATIBILITY_BRIDGE,
    ]);
  }

  const release = structuredClone(previousReleaseInventory.releases.at(-1)!);
  const chunk = release.chunks.find((entry) => entry.path.startsWith("update-run-ledger-"))!;
  chunk.imports.push({
    importer: "fixture.mjs",
    owner: "src/cli/update-cli/update-command-service-recovery.ts",
    exports: [chunk.exports[0]!.exported],
  });
  expect(() => emit({ schemaVersion: 1, releases: [release] })).toThrow(/must run isolated/);
});
