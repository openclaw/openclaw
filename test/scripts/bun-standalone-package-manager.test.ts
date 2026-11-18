import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { planStandalonePackageManager } from "../../scripts/lib/bun-standalone-package-manager.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";

it("runs packaged npm config and script-free pack after pruning the source dependency tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-package-manager-"));
  try {
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"name":"fixture"}');
    const installed = path.dirname(createRequire(import.meta.url).resolve("npm/package.json"));
    fs.cpSync(installed, path.join(runtimeRoot, "node_modules/npm"), { recursive: true });
    const manager = planStandalonePackageManager(runtimeRoot);
    const plan = planStandaloneRuntime(runtimeRoot, manager.files);
    expect(plan.pruning.categories.packageManager).toEqual({
      files: manager.manifest.fileCount,
      bytes: manager.manifest.sizeBytes,
    });
    pruneStandaloneRuntime(plan);
    expect(fs.existsSync(path.join(runtimeRoot, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(runtimeRoot, "npm/docs"))).toBe(false);
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, ".npmrc"), "registry=https://registry.example/\n");
    fs.writeFileSync(path.join(project, "index.js"), "module.exports = 42;\n");
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "standalone-pack-fixture",
        version: "1.0.0",
        scripts: { prepack: "node -e \"require('fs').writeFileSync('script-ran', 'bad')\"" },
      }),
    );
    const env = {
      ...process.env,
      HOME: root,
      NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"),
      NPM_CONFIG_CACHE: path.join(root, "cache"),
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    };
    const run = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [path.join(runtimeRoot, manager.manifest.entrypoint), ...args],
        {
          cwd: project,
          env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    expect(run(["config", "get", "registry"])).toBe("https://registry.example/");
    const packedOutput = JSON.parse(run(["pack", ".", "--ignore-scripts", "--json"]));
    const packed = packedOutput["standalone-pack-fixture"];
    expect(packed.name).toBe("standalone-pack-fixture");
    expect(packed.integrity).toBe(
      `sha512-${createHash("sha512")
        .update(fs.readFileSync(path.join(project, packed.filename)))
        .digest("base64")}`,
    );
    expect(fs.existsSync(path.join(project, "script-ran"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
