import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function installLineCapToolingFixture(checkout: string) {
  // Copy the actual entry/import closure: symlinking it would use the installed checkout's loader.
  for (const name of [
    "tsx.mjs",
    "check-line-cap-ratchet.mts",
    "windows-cmd-helpers.mjs",
    "lib/check-limits.mts",
    "lib/direct-run.mjs",
    "lib/local-check-runtime.mts",
    "lib/managed-child-process.mts",
    "lib/managed-cleanup-handoff.mts",
    "lib/shrink-ratchet.mts",
    "lib/tooling-dependencies.mjs",
    "lib/tsx-cli-shim.mjs",
    "lib/vitest-resource-ownership.mts",
    "lib/windows-taskkill.mjs",
    ...(existsSync(resolve("scripts/check-line-cap-ratchet.mjs"))
      ? ["check-line-cap-ratchet.mjs"]
      : []),
  ]) {
    const target = join(checkout, "scripts", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve("scripts", name), target);
  }
  copyFileSync(resolve("package.json"), join(checkout, "package.json"));
  const origin = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["config", "remote.origin.url", origin], { cwd: checkout });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    GITHUB_ACTIONS: "",
    OPENCLAW_PR_TOOLING_ROOT: process.cwd(),
  };
  for (const name of [
    "PNPM_CONFIG_MODULES_DIR",
    "pnpm_config_modules_dir",
    "npm_config_modules_dir",
    "OPENCLAW_PR_GIT",
  ]) {
    delete env[name];
  }
  return { env };
}

export function createToolingDependencyFixture(root: string, staleAncestor = false) {
  const checkout = join(root, "checkout");
  const tooling = join(root, "tooling #root");
  const lib = join(checkout, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  for (const directory of [checkout, tooling]) {
    for (const args of [
      ["init", "--quiet", directory],
      ["-C", directory, "remote", "add", "origin", "https://github.com/openclaw/openclaw.git"],
    ]) {
      const result = spawnSync("git", args, { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }
    }
  }
  for (const name of [
    "tsx-cli-shim.mjs",
    "tooling-dependencies.mjs",
    "local-check-runtime.mts",
    "managed-cleanup-handoff.mts",
  ]) {
    copyFileSync(resolve("scripts/lib", name), join(lib, name));
  }
  for (const name of ["tsx.mjs", "crabbox-wrapper.mjs"]) {
    copyFileSync(resolve("scripts", name), join(checkout, "scripts", name));
  }
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({
      devDependencies: { tsx: "1.0.0", "fixture-pkg": "1.0.0", "private-pkg": "1.0.0" },
    }),
  );
  function writePackage(
    name: string,
    source: string,
    version = "1.0.0",
    owner = tooling,
    subpaths: Record<string, string> = {},
  ) {
    const directory = join(owner, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    const exports: Record<string, string> =
      name === "tsx" ? { "./esm": "./index.mjs" } : { ".": "./index.mjs" };
    for (const [subpath, subpathSource] of Object.entries(subpaths)) {
      exports[subpath] = `${subpath}.mjs`;
      writeFileSync(join(directory, `${subpath}.mjs`), subpathSource);
    }
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version, type: "module", exports }),
    );
    writeFileSync(join(directory, "index.mjs"), source);
    return directory;
  }
  // Exercise the preload contract without installing a compiler in the fixture.
  writePackage("tsx", 'process.env.TOOLING_FIXTURE_PRELOADED = "1";');
  const packageRoot = writePackage(
    "fixture-pkg",
    'export default "qualified"; export { default as privateValue } from "private-pkg";',
  );
  writePackage("private-pkg", 'export default "root";');
  writePackage("private-pkg", 'export default "private";', "2.0.0", packageRoot);
  if (staleAncestor) {
    writePackage(
      "fixture-pkg",
      'export default "stale ancestor"; export const privateValue = "private";',
      "0.0.0-stale",
      root,
    );
  }
  writeFileSync(
    join(checkout, "scripts/crabbox-wrapper.mts"),
    `import assert from "node:assert/strict";
import value, { privateValue } from "fixture-pkg";
assert.equal(value, "qualified");
assert.equal(privateValue, "private");
assert.equal(process.env.TOOLING_FIXTURE_PRELOADED, "1");
assert.equal(process.env.TSX_DISABLE_CACHE, "1");
assert.equal(process.argv[2], "--help");
console.log("qualified bootstrap OK");
`,
  );
  writeFileSync(
    join(checkout, "scripts/ordinary.mjs"),
    'import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs"; await runTsxCliShim(import.meta.url, { implementation: "./crabbox-wrapper.mts" });',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    OPENCLAW_PR_TOOLING_ROOT: tooling,
  };
  for (const name of [
    "PNPM_CONFIG_MODULES_DIR",
    "pnpm_config_modules_dir",
    "npm_config_modules_dir",
    "OPENCLAW_PR_GIT",
    "TOOLING_FIXTURE_PRELOADED",
  ]) {
    delete env[name];
  }
  return {
    checkout,
    tooling,
    writePackage,
    run: (entrypoint = "crabbox-wrapper.mjs") =>
      spawnSync(process.execPath, [join(checkout, "scripts", entrypoint), "--help"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}
