import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { stageStandalonePluginLoader } from "../../scripts/lib/bun-standalone-plugins.mjs";
import { createStandaloneRequireAdapter } from "../../scripts/lib/bun-standalone-require.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.each(["jit", "bytecode", "aot"])(
  "uses the relocated loader only for dynamic hosts (%s)",
  async (mode) => {
    const root = temporary.make("standalone-plugin-loader-");
    const artifact = path.join(root, "artifact");
    const runtimeRoot = path.join(artifact, "runtime");
    const jitiRoot = path.join(runtimeRoot, "node_modules/jiti");
    fs.mkdirSync(jitiRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"openclaw"}');
    fs.writeFileSync(path.join(jitiRoot, "package.json"), '{"name":"jiti","main":"index.cjs"}');
    fs.writeFileSync(path.join(jitiRoot, "LICENSE"), "fixture license");
    fs.writeFileSync(
      path.join(jitiRoot, "index.cjs"),
      `globalThis.fixtureLoaderEvaluations = (globalThis.fixtureLoaderEvaluations ?? 0) + 1;
exports.createJiti = () => "fixture factory";`,
    );
    const loader = await stageStandalonePluginLoader({
      runtimeRoot,
      outputRoot: artifact,
      build: async (options) => {
        const result = await build({
          entryPoints: options.entrypoints,
          outdir: options.outdir,
          entryNames: "index",
          outExtension: { ".js": ".cjs" },
          platform: "node",
          format: options.format,
          bundle: true,
        });
        return { success: true, logs: result.warnings };
      },
    });
    const adapter = createStandaloneRequireAdapter({
      runtimeRoot,
      embeddedPaths: {},
      pluginLoader: loader,
    });
    expect(fs.existsSync(path.join(artifact, "plugin-loader-entry.cjs"))).toBe(false);
    fs.writeFileSync(
      path.join(artifact, "bootstrap.mjs"),
      `import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("./runtime/", import.meta.url));
globalThis.__openclawStandaloneBuildInfo = Object.freeze({ mode: ${JSON.stringify(mode)} });
const resolveFilename = Module._resolveFilename;
${adapter.bootstrap}
assert.equal(Module._resolveFilename, resolveFilename);
assert.equal(globalThis.fixtureLoaderEvaluations, undefined);
if (${JSON.stringify(mode)} === "aot") {
  assert.equal(globalThis.openclawStandaloneLoadJitiFactory, undefined);
  console.log("embedded host leaves loader inactive");
} else {
  const first = globalThis.openclawStandaloneLoadJitiFactory();
  assert.equal(first(), "fixture factory");
  assert.equal(globalThis.openclawStandaloneLoadJitiFactory(), first);
  assert.equal(globalThis.fixtureLoaderEvaluations, 1);
  console.log("lazy relocated factory");
}`,
    );
    const plan = planStandaloneRuntime(runtimeRoot, loader.files);
    expect(plan.pruning.categories).toMatchObject({ pluginLoader: { files: 3 } });
    pruneStandaloneRuntime(plan);
    const moved = path.join(root, "relocated");
    fs.renameSync(artifact, moved);
    expect(fs.existsSync(path.join(moved, "runtime/node_modules/jiti"))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(moved, "runtime/node_modules/@openclaw/plugin-loader/LICENSE"),
        "utf8",
      ),
    ).toBe("fixture license");
    const result = spawnSync(process.execPath, [path.join(moved, "bootstrap.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      mode === "aot" ? "embedded host leaves loader inactive" : "lazy relocated factory",
    );
  },
);
