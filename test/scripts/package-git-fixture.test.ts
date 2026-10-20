import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("package git fixture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const sourceScripts = {
    openclaw: "node scripts/run-node.mjs",
    postinstall: "node scripts/postinstall-bundled-plugins.mjs",
  };
  function write(root: string, file: string, content: string | object) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
  }
  function readJson(root: string, file = "package.json") {
    return JSON.parse(readFileSync(path.join(root, file), "utf8"));
  }
  function prepare(root: string) {
    const result = spawnSync(
      process.execPath,
      ["scripts/e2e/lib/package-git-fixture.mjs", "prepare", root],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }

  it("installs the packed runtime without resolving checkout-only development dependencies", () => {
    const root = tempDirs.make("openclaw-package-git-fixture-install-");
    const runtimeDir = path.join(root, "runtime");
    write(runtimeDir, "package.json", {
      name: "fixture-runtime",
      version: "1.0.0",
      main: "index.cjs",
    });
    write(runtimeDir, "index.cjs", 'module.exports = "packed runtime";\n');
    write(root, "package.json", {
      name: "prebuilt-fixture",
      version: "1.0.0",
      dependencies: { "fixture-runtime": "file:./runtime" },
      devDependencies: { "checkout-build-tool": "workspace:*" },
    });
    prepare(root);
    const npm = resolveNpmRunner({
      npmArgs: "install --omit=dev --offline --ignore-scripts --no-fund --no-audit".split(" "),
    });
    const installed = spawnSync(npm.command, npm.args, {
      cwd: root,
      encoding: "utf8",
      env: npm.env,
      shell: npm.shell,
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
      timeout: 30_000,
    });
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    const runtime = spawnSync(process.execPath, ["-p", 'require("fixture-runtime")'], {
      cwd: root,
      encoding: "utf8",
    });
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout.trim()).toBe("packed runtime");
  });

  it("stages bundled ai runtime as a local file dependency", async () => {
    const root = tempDirs.make("openclaw-package-git-fixture-");
    write(root, ".gitignore", "dist/\n");
    write(root, "package.json", {
      dependencies: { "@openclaw/ai": "2026.6.11", chalk: "5.6.2" },
      bundleDependencies: ["@openclaw/ai", "chalk"],
      scripts: { ...sourceScripts, build: "node build.mjs" },
    });
    write(root, "node_modules/@openclaw/ai/package.json", {
      name: "@openclaw/ai",
      version: "2026.6.11",
      type: "module",
      main: "./dist/index.mjs",
      exports: { ".": "./dist/index.mjs" },
      devDependencies: { "@openclaw/normalization-core": "0.0.0-private" },
    });
    prepare(root);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/u)).toEqual(
      expect.arrayContaining(["dist/", "node_modules", "**/node_modules/", "pnpm-lock.yaml"]),
    );
    const packageJson = readJson(root);
    expect(packageJson.dependencies["@openclaw/ai"]).toBe("file:.openclaw-fixture/packages/ai");
    expect(packageJson.bundleDependencies).toEqual(["chalk"]);
    expect(packageJson.scripts).toEqual({ build: "node build.mjs", openclaw: "node openclaw.mjs" });
    const relocatedAiPackage = readJson(root, ".openclaw-fixture/packages/ai/package.json");
    expect(relocatedAiPackage).toMatchObject({
      name: "@openclaw/ai",
      version: "2026.6.11",
      type: "module",
      main: "./dist/index.mjs",
      exports: { ".": "./dist/index.mjs" },
    });
    expect(relocatedAiPackage).not.toHaveProperty("devDependencies");

    write(root, "node_modules/chalk/package.json", "{}\n");
    write(root, ".openclaw-fixture/packages/ai/node_modules/zod/package.json", "{}\n");
    write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    for (const destination of ["dist", "node_modules"]) {
      const staging = path.join(
        root,
        `${destination}.openclaw-update-00000000-0000-4000-8000-000000000000.tmp`,
      );
      mkdirSync(staging);
      writeFileSync(path.join(staging, "candidate"), "staged runtime");
    }
    writeFileSync(path.join(root, "operator-notes.tmp"), "keep visible");
    expect(spawnSync("git", ["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" }).status).toBe(0);
    const staged = spawnSync("git", ["-C", root, "diff", "--cached", "--name-only"], {
      encoding: "utf8",
    });
    expect(staged.status).toBe(0);
    expect(staged.stdout).not.toContain("node_modules");
    expect(staged.stdout).not.toContain("pnpm-lock.yaml");
    expect(staged.stdout).not.toContain(".openclaw-update-");
    expect(staged.stdout).toContain("operator-notes.tmp");
  });

  it("uses the packed entrypoint without a bundled ai runtime", () => {
    const root = tempDirs.make("openclaw-package-git-fixture-no-ai-");
    write(root, "package.json", {
      dependencies: { chalk: "5.6.2" },
      scripts: { ...sourceScripts, lint: "node lint.mjs" },
    });
    prepare(root);
    const packageJson = readJson(root);
    expect(packageJson.scripts).toEqual({ lint: "node lint.mjs", openclaw: "node openclaw.mjs" });
    expect(packageJson.dependencies).not.toHaveProperty("@openclaw/ai");
  });
});
