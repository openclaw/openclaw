import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import { writeUpdateCompatibilityChunks } from "../../scripts/lib/update-compat-chunks.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";
import { previousReleaseInventory } from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();

it("loads published updater Node-runner bridges without the replaced dependency graph", async () => {
  const entryName = "cli/update-cli/node-runner";
  const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
  const selected = configs.find((config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP);
  if (!selected?.entry || typeof selected.entry !== "object" || Array.isArray(selected.entry)) {
    throw new Error("Missing unified runtime entries");
  }
  const source = selected.entry[entryName];
  expect(source, "published updater bootstrap requires an isolated build entry").toBeDefined();
  if (!source) {
    throw new Error("Missing updater Node-runner entry");
  }
  const root = fs.realpathSync(createTempDir("openclaw-update-node-runner-build-"));
  const distDir = path.join(root, "dist");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const { bundles } = await build({
    ...selected,
    config: false,
    entry: { [entryName]: source },
    outDir: distDir,
    dts: false,
    logLevel: "silent",
  });
  try {
    const releases = previousReleaseInventory.releases.flatMap((release) => {
      const chunks = release.chunks.filter(
        (chunk) => chunk.exports.length === 1 && chunk.exports[0]?.exported === "resolveNodeRunner",
      );
      return chunks.length ? [{ ...release, chunks }] : [];
    });
    expect(releases.length).toBeGreaterThan(0);
    const bridges = writeUpdateCompatibilityChunks({
      distDir,
      sourceDir: process.cwd(),
      inventory: { schemaVersion: 1, releases },
    });
    expect(bridges.length).toBeGreaterThan(0);
    const output = execFileSync(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "-e",
        `
import assert from "node:assert/strict";
import { isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
registerHooks({ resolve(specifier, context, next) {
  if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("file:")) {
    throw new Error("post-swap bootstrap loaded a package dependency: " + specifier);
  }
  return next(specifier, context);
}});
for (const bridge of process.argv.slice(1)) {
  const { resolveNodeRunner } = await import(pathToFileURL(bridge).href);
  const original = process.execPath;
  assert.equal(resolveNodeRunner(), original);
  for (const name of ["node", "NODE.EXE", "bun"]) {
    Object.defineProperty(process, "execPath", { value: path.join(path.dirname(original), name), configurable: true });
    assert.equal(resolveNodeRunner(), name === "bun" ? "node" : process.execPath);
  }
  Object.defineProperty(process, "execPath", { value: original, configurable: true });
}
console.log("published bootstrap passed");
`,
        ...bridges.map((bridge) => path.join(distDir, bridge)),
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    expect(output.trim()).toBe("published bootstrap passed");
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
