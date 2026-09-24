import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import {
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
  type UpdateCompatibilityInventory,
} from "../../scripts/lib/update-compat-chunks.mts";
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

it("records compact multi-module origins and bridges a cached updater across replacement", async () => {
  const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
  const selected = configs.find(
    (config) =>
      config.dts === false &&
      typeof config.entry === "object" &&
      !Array.isArray(config.entry) &&
      config.entry?.entry === "src/entry.ts",
  );
  if (!selected) {
    throw new Error("Missing shared runtime graph");
  }
  const root = fs.realpathSync(createTempDir("openclaw-compact-update-"));
  const write = (file: string, source: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  const literal = "line\n//#region src/cli/update-cli/decoy.ts\n//!#region src/infra/forged.ts\n";
  const command = "src/cli/update-cli/update-command-service-command.ts";
  write("package.json", '{"type":"module"}');
  write(
    command,
    'export async function restart() { const value = await import("../../surface.js"); return [value.left(), value.right(), value.literal, value.pattern.source]; }',
  );
  write(
    "src/surface.ts",
    'export { left } from "./infra/left.js"; export { right, literal, pattern } from "./infra/right.js";',
  );
  const releaseRoot = path.join(root, "release");
  const currentDist = path.join(root, "current/dist");
  let inventory: UpdateCompatibilityInventory | undefined;
  for (const version of ["old", "new"]) {
    write("src/infra/left.ts", `export function left() { return "${version}-left"; }`);
    write(
      "src/infra/right.ts",
      `export function right() { return "${version}-right"; }\nexport const literal = String.raw\`${literal}\`;\nexport const pattern = /[/*]#region/g;`,
    );
    const outDir = version === "old" ? path.join(releaseRoot, "dist") : currentDist;
    const { bundles } = await build({
      ...selected,
      config: false,
      cwd: root,
      entry: { command: path.join(root, command) },
      outDir,
      clean: false,
      tsconfig: false,
      dts: false,
      logLevel: "silent",
    });
    try {
      expect(
        bundles.some((bundle) =>
          bundle.chunks.some(
            (chunk) =>
              chunk.type === "chunk" &&
              ["left", "right"].every((name) =>
                chunk.moduleIds.includes(path.join(root, `src/infra/${name}.ts`)),
              ),
          ),
        ),
      ).toBe(true);
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
    if (version === "old") {
      write(
        "release/package.json",
        JSON.stringify({ name: "openclaw", version: "2026.9.1", type: "module" }),
      );
      write(
        "release/dist/build-info.json",
        JSON.stringify({ version: "2026.9.1", buildId: "fixture", commit: "0".repeat(40) }),
      );
      const release = recordUpdateCompatibilityRelease({
        packageDir: releaseRoot,
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      });
      expect(release.chunks.flatMap((chunk) => chunk.exports)).toEqual(
        ["left", "literal", "pattern", "right"].map((exported) => ({
          exported,
          origin: {
            module: `src/infra/${exported === "left" ? "left" : "right"}.ts`,
            symbol: exported,
          },
        })),
      );
      inventory = { schemaVersion: 1, releases: [release] };
    }
  }
  if (!inventory) {
    throw new Error("Missing recorded release");
  }
  expect(
    writeUpdateCompatibilityChunks({ distDir: currentDist, sourceDir: root, inventory }),
  ).not.toHaveLength(0);
  const output = execFileSync(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        const old = await import("./release/dist/command.js");
        fs.rmSync("./release/dist", { recursive: true });
        fs.renameSync("./current/dist", "./release/dist");
        assert.deepEqual(await old.restart(), ${JSON.stringify(["new-left", "new-right", literal, "[/*]#region"])});
        console.log("compact replacement passed");
      `,
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  expect(output.trim()).toBe("compact replacement passed");
});
