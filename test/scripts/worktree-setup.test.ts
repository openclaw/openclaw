import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readBundledPluginAssetHooks } from "../../scripts/bundled-plugin-assets.mts";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { createWorktreeSetupPlan, parseWorktreeSetupArgs } from "../../scripts/worktree-setup.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Seed the entrypoint and its lazy runtime helpers; copy their eager source closure.
// Cold subprocesses still run original bytes without a loader or node_modules.
const COLD_SCRIPT_INPUTS = collectRuntimeImportClosure(repoRoot, [
  "scripts/worktree-setup.mjs",
  "scripts/bundled-plugin-assets.mts",
  "scripts/pnpm-runner.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/output-root-guard.mjs",
]);

type CommandCall = { kind: "pnpm"; args: string[]; cwd: string };

function makePreparationFixture() {
  const directory = tempDirs.make("openclaw-preparation-");
  const rootDir = path.join(directory, "repo");
  const controls = path.join(directory, "controls");
  fs.mkdirSync(rootDir);
  fs.mkdirSync(controls);
  const write = (relative: string, value: string) => {
    const target = path.join(rootDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  const json = (relative: string, value: unknown) => write(relative, JSON.stringify(value));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  // Cold execution must not inherit a loader or package path from the test runner.
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "npm_execpath",
    "OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS",
    "OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS",
    "OPENCLAW_INCLUDE_OPTIONAL_BUNDLED",
    "OPENCLAW_BUILD_PRIVATE_QA",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });
  for (const input of COLD_SCRIPT_INPUTS) {
    write(input, fs.readFileSync(path.join(repoRoot, input), "utf8"));
  }
  const pin: string = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).packageManager;
  json("package.json", { name: "openclaw", type: "module", packageManager: pin });
  write("pnpm-workspace.yaml", "packages:\n  - .\n  - packages/*\n  - extensions/*\n  - ui\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  json("ui/package.json", { name: "openclaw-control-ui", version: "0.0.0" });
  json("packages/support/package.json", { name: "@openclaw/support", version: "0.0.0" });
  json("extensions/isolated/package.json", {
    name: "@openclaw/isolated",
    dependencies: { "@openclaw/support": "workspace:*" },
    openclaw: {
      extensions: ["./index.ts"],
      build: { bundledDist: false },
      release: { publishToNpm: true },
    },
  });
  json("extensions/isolated/openclaw.plugin.json", { id: "isolated" });
  write("extensions/isolated/index.ts", "export {};\n");
  // No manifest or entrypoint: these owners exist only in the asset inventory.
  for (const phase of ["build", "copy"]) {
    json("extensions/asset-" + phase + "/package.json", {
      name: "@example/asset-" + phase,
      openclaw: { assetScripts: { [phase]: "node asset.mjs" } },
    });
  }
  write(".openclaw/worktree-profiles/gateway", "scripts\npackages\nextensions\nsrc\n");
  write("src/gateway/input.ts", "export {};\n");
  write("apps/android/build.gradle.kts", "// Omitted by the synthetic gateway cone.\n");

  // Preparation validates these inputs but no retained case may reach a build.
  write("scripts/tsx.mjs", "export {};\n");
  write("scripts/build-all.mts", 'throw new Error("unexpected fixture build");\n');
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Setup Test",
    "-c",
    "user.email=setup@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + controls,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );

  const callsPath = path.join(controls, "calls.jsonl");
  const pnpmPath = path.join(controls, "pnpm.cjs");
  const recorder = [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.SETUP_TEST_CALLS, JSON.stringify({",
    '  kind: "pnpm", args, cwd: process.cwd(),',
    '}) + "\\n");',
    'if (args.length === 1 && args[0] === "--version") {',
    "  console.log(process.env.SETUP_TEST_VERSION);",
    '} else if (args.join(" ") === "store path") {',
    "  if (process.env.SETUP_TEST_STORE_HOOK) { require(process.env.SETUP_TEST_STORE_HOOK); }",
    "  console.log(process.env.SETUP_TEST_STORE);",
    "} else {",
    "  process.exitCode = 97;",
    "}",
  ].join("\n");
  fs.writeFileSync(pnpmPath, recorder);
  // Trap fallback resolution as well; no test may invoke the host's real pnpm.
  fs.writeFileSync(path.join(controls, "pnpm"), "#!/usr/bin/env node\n" + recorder, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(controls, "pnpm.cmd"),
    '@"' + process.execPath + '" "' + pnpmPath + '" %*\r\n',
  );
  Object.assign(env, {
    npm_execpath: pnpmPath,
    PATH:
      controls +
      path.delimiter +
      path.dirname(process.execPath) +
      path.delimiter +
      (env.PATH ?? ""),
    SETUP_TEST_CALLS: callsPath,
    SETUP_TEST_VERSION: pin.slice("pnpm@".length).split("+")[0],
    SETUP_TEST_STORE: path.join(controls, "store", "not-created"),
  });

  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(
      process.execPath,
      [path.join(rootDir, "scripts/worktree-setup.mjs"), ...args],
      { cwd: rootDir, env: { ...env, ...extraEnv }, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    return result;
  };
  const calls = (): CommandCall[] =>
    fs.existsSync(callsPath)
      ? fs
          .readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const assertNoOutputs = () => {
    for (const relative of [
      "node_modules",
      "dist",
      "packages/support/node_modules",
      "extensions/isolated/node_modules",
      "ui/node_modules",
      "apps/android/build",
    ]) {
      expect(fs.existsSync(path.join(rootDir, relative)), relative).toBe(false);
    }
  };
  return { rootDir, controls, env, run, git, calls, assertNoOutputs };
}

describe("source-only worktree preparation", () => {
  it("rejects invalid selectors before reading repository inputs", async () => {
    expect(() => parseWorktreeSetupArgs(["gateway", "full"])).toThrow("Unexpected");
    expect(() => parseWorktreeSetupArgs(["--profile", "gateway"])).toThrow("Unexpected");
    expect(() => parseWorktreeSetupArgs(["--source-profile", "gateway"])).toThrow("Unexpected");
    await expect(
      createWorktreeSetupPlan({ rootDir: "/missing-worktree", workload: "unknown" }),
    ).rejects.toThrow("Unknown preparation workload");
  });

  it.skipIf(process.platform === "win32")(
    "keeps the actual Claude startup hook source-only",
    () => {
      const fixture = makePreparationFixture();
      const settings = JSON.parse(
        fs.readFileSync(path.join(repoRoot, ".claude/settings.json"), "utf8"),
      ) as {
        hooks: { SessionStart: { matcher: string; hooks: { type: string; command: string }[] }[] };
      };
      const hooks = settings.hooks.SessionStart.filter((entry) => entry.matcher === "startup")
        .flatMap((entry) => entry.hooks)
        .filter((hook) => hook.type === "command");
      expect(hooks.length).toBeGreaterThan(0);
      // Source startup must work even when the cone cannot prepare the gateway.
      // Keep only scripts: the missing tracked plugin would fail input validation
      // if startup accidentally inferred gateway preparation from sparse state.
      for (const state of ["full", "sparse"]) {
        if (state === "sparse") {
          fixture.git("sparse-checkout", "set", "--cone", "scripts");
          expect(fs.existsSync(path.join(fixture.rootDir, "extensions/isolated/index.ts"))).toBe(
            false,
          );
        }
        const before = fixture.git("status", "--porcelain", "--untracked-files=all");
        for (const hook of hooks) {
          const output = execFileSync("/bin/sh", ["-c", hook.command], {
            cwd: path.join(fixture.rootDir, "scripts"),
            env: fixture.env,
            encoding: "utf8",
          });
          expect(output).toContain("Source-only");
        }
        expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe(before);
        if (state === "sparse") {
          expect(fixture.git("sparse-checkout", "list").trim()).toBe("scripts");
        }
        expect(fixture.calls()).toEqual([]);
        fixture.assertNoOutputs();
      }
    },
  );
});

describe("explicit preparation input closure", () => {
  it("plans the actual checkout from canonical source and both asset inventories", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const entries = collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot, env: {} });
    const buildHooks = await readBundledPluginAssetHooks({ rootDir: repoRoot, phase: "build" });
    const copyHooks = await readBundledPluginAssetHooks({ rootDir: repoRoot, phase: "copy" });
    expect(entries.length).toBeGreaterThan(0);
    expect(buildHooks.length).toBeGreaterThan(0);
    expect(copyHooks.length).toBeGreaterThan(0);
    const expected = new Set([pkg.name + "...", "./packages/*...", "./ui..."]);
    for (const entry of entries) {
      if (entry.hasPackageJson) {
        expected.add("./extensions/" + entry.id + "...");
      }
    }
    for (const hook of [...buildHooks, ...copyHooks]) {
      expected.add(
        "./" + path.relative(repoRoot, hook.pluginDir).split(path.sep).join("/") + "...",
      );
    }
    const plan = await createWorktreeSetupPlan({ rootDir: repoRoot, workload: "gateway", env: {} });
    expect(plan.install).toEqual({
      command: "pnpm",
      args: [...expected]
        .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .flatMap((filter) => ["--filter", filter])
        .concat(["install", "--frozen-lockfile"]),
    });
    expect(plan.build).toEqual({
      command: "node",
      args: ["--import", "./scripts/tsx.mjs", "scripts/build-all.mts", "qaRuntime"],
    });
  });

  it("rejects a gateway selection changed during toolchain checks before install", () => {
    const fixture = makePreparationFixture();
    const hook = path.join(fixture.controls, "change-owner.cjs");
    fs.writeFileSync(
      hook,
      [
        'const fs = require("node:fs");',
        'const file = "extensions/asset-copy/package.json";',
        'const pkg = JSON.parse(fs.readFileSync(file, "utf8"));',
        "delete pkg.openclaw.assetScripts.copy;",
        "fs.writeFileSync(file, JSON.stringify(pkg));",
      ].join("\n"),
    );
    const result = fixture.run(["gateway"], { SETUP_TEST_STORE_HOOK: hook });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Preparation inputs changed");
    expect(fixture.calls().map((call) => call.args)).toEqual([["--version"], ["store", "path"]]);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(fixture.rootDir, "extensions/asset-copy/package.json"), "utf8"),
    );
    expect(pkg.openclaw.assetScripts.copy).toBeUndefined();
    fixture.assertNoOutputs();
  });
});

// These are subprocess/ordering regressions. Recorders never install packages,
// prove pnpm closure, build the Gateway, or establish graph/volume isolation.
describe("shared preparation preflight", () => {
  const workload = "gateway";
  it("rejects linked package node_modules before invoking pnpm and preserves its target", () => {
    const fixture = makePreparationFixture();
    const target = path.join(fixture.controls, "retained");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
    const link = path.join(fixture.rootDir, "packages/support/node_modules");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    const result = fixture.run([workload]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symbolic link");
    expect(fixture.calls()).toEqual([]);
    expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("unchanged");
    expect(fs.readdirSync(target)).toEqual(["sentinel"]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("revalidates missing inputs after store resolution and before install", () => {
    const fixture = makePreparationFixture();
    const hook = path.join(fixture.controls, "remove-input.cjs");
    fs.writeFileSync(hook, 'require("node:fs").unlinkSync("extensions/isolated/index.ts");\n');
    const result = fixture.run([workload], { SETUP_TEST_STORE_HOOK: hook });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Tracked preparation inputs are missing");
    expect(result.stderr).toContain("extensions/isolated/index.ts");
    expect(fs.existsSync(path.join(fixture.rootDir, "extensions/isolated/index.ts"))).toBe(false);
    expect(fixture.calls().map((call) => call.args)).toEqual([["--version"], ["store", "path"]]);
    fixture.assertNoOutputs();
  });

  it("revalidates output roots after store resolution and before install", () => {
    const fixture = makePreparationFixture();
    const target = path.join(fixture.controls, "retained");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
    const hook = path.join(fixture.controls, "link-output.cjs");
    fs.writeFileSync(
      hook,
      [
        'const fs = require("node:fs");',
        "fs.symlinkSync(" +
          JSON.stringify(target) +
          ', "dist", ' +
          JSON.stringify(process.platform === "win32" ? "junction" : "dir") +
          ");",
      ].join("\n"),
    );
    const result = fixture.run([workload], { SETUP_TEST_STORE_HOOK: hook });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symbolic link");
    expect(fixture.calls().map((call) => call.args)).toEqual([["--version"], ["store", "path"]]);
    expect(fs.lstatSync(path.join(fixture.rootDir, "dist")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(target)).toEqual(["sentinel"]);
    expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(fixture.rootDir, "node_modules"))).toBe(false);
  });
});
