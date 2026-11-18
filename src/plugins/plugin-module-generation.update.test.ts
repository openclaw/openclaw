import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { gitRuntimeStagingPath } from "../infra/update-runtime-staging.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

it.each(["package", "standalone", "native"])(
  "loads current plugin code while Git rollback dependencies are retained (%s)",
  (mode) => {
    const standalone = mode === "standalone";
    const root = fixture({
      "package.json": '{"name":"update-fixture"}',
      "assets/value.txt": "current asset",
      ...(mode === "native" ? { "assets/tool.bin": "native companion" } : {}),
      "index.mjs": `import fs from 'node:fs';
        const assets = new URL('./assets/', import.meta.url);
        export const read = () => fs.readFileSync(new URL('value.txt', assets), 'utf8');`,
    });
    const owner = mode === "package" ? root : path.join(root, "assets");
    const modules = path.join(owner, "node_modules");
    fs.mkdirSync(path.join(owner, "sdk"));
    fs.mkdirSync(path.join(modules, "@fixture"), { recursive: true });
    const sdk = path.join(modules, "@fixture", "sdk");
    fs.symlinkSync("../../sdk", sdk, "junction");
    expect(fs.realpathSync(sdk)).toBe(fs.realpathSync(path.join(owner, "sdk")));

    // Published Git updaters retain the old runtime beside its final location.
    const staging = gitRuntimeStagingPath(modules);
    fs.mkdirSync(staging);
    fs.renameSync(modules, path.join(staging, "previous"));
    fs.mkdirSync(modules);
    const previousSdk = path.join(staging, "previous", "@fixture", "sdk");
    expect(fs.lstatSync(previousSdk).isSymbolicLink()).toBe(true);
    // POSIX keeps the relative link; Windows junctions retain their absolute target.
    expect(fs.existsSync(previousSdk)).toBe(process.platform === "win32");

    const plugin = host(root, standalone).load("index.mjs") as { read(): string };
    expect(plugin.read()).toBe("current asset");
    expect(fs.lstatSync(previousSdk).isSymbolicLink()).toBe(true);
    fs.rmSync(staging, { recursive: true });
    expect(plugin.read()).toBe("current asset");
    expect((host(root, standalone).load("index.mjs") as { read(): string }).read()).toBe(
      "current asset",
    );
  },
);

it("still loads a dependency explicitly selected from a transaction-named directory", () => {
  const root = fixture({
    "package.json": '{"dependencies":{"fixture":"1.0.0"}}',
    "index.cjs": "module.exports = require('fixture');",
  });
  const dependency = gitRuntimeStagingPath(path.join(root, "store"));
  fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, "package.json"), '{"name":"fixture","main":"index.cjs"}');
  fs.writeFileSync(path.join(dependency, "index.cjs"), "exports.value = 'selected dependency';");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(dependency, path.join(root, "node_modules", "fixture"), "junction");
  expect(host(root).load("index.cjs")).toMatchObject({ value: "selected dependency" });
  expect(fs.existsSync(dependency)).toBe(true);
});
