import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readBundledPluginAssetHooks } from "../../scripts/bundled-plugin-assets.mts";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { createWorktreeSetupPlan, parseWorktreeSetupArgs } from "../../scripts/worktree-setup.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { collectEagerRuntimeImportClosure } from "./eager-import-closure.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = path.join(repoRoot, "scripts/worktree-setup.mjs");

// Seed the entrypoint and its lazy runtime helpers; copy their eager source closure.
// Cold subprocesses still run original bytes without a loader or node_modules.
const COLD_SCRIPT_INPUTS = collectEagerRuntimeImportClosure([
  "scripts/worktree-setup.mjs",
  "scripts/bundled-plugin-assets.mts",
  "scripts/pnpm-runner.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/output-root-guard.mjs",
]);

type CommandCall = { kind: "pnpm" | "gateway-build"; args: string[]; cwd: string };

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
  write("pnpm-workspace.yaml", "packages:\n  - .\n  - packages/*\n  - extensions/*\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
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

  // These two files are command recorders, NOT a gateway build implementation.
  write("scripts/tsx.mjs", "export {};\n");
  write(
    "scripts/build-all.mts",
    [
      'import fs from "node:fs";',
      "fs.appendFileSync(process.env.SETUP_TEST_CALLS, JSON.stringify({",
      '  kind: "gateway-build", args: process.argv.slice(2), cwd: process.cwd(),',
      '}) + "\\n");',
      'process.exitCode = Number(process.env.SETUP_TEST_BUILD_EXIT ?? "0");',
    ].join("\n"),
  );
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
    '} else if (args.includes("install")) {',
    '  process.exitCode = Number(process.env.SETUP_TEST_INSTALL_EXIT ?? "0");',
    '} else if (args.join(" ") === "build") {',
    '  process.exitCode = Number(process.env.SETUP_TEST_BUILD_EXIT ?? "0");',
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

  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []) => {
    const result = spawnSync(
      process.execPath,
      [...nodeArgs, path.join(rootDir, "scripts/worktree-setup.mjs"), ...args],
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
      "apps/android/build",
    ]) {
      expect(fs.existsSync(path.join(rootDir, relative)), relative).toBe(false);
    }
  };
  return { rootDir, controls, env, run, git, write, calls, assertNoOutputs };
}

describe("source-only worktree preparation", () => {
  it("runs source plans without Git, pnpm, repository imports, or generated output", () => {
    const rootDir = tempDirs.make("openclaw-source-preparation-");
    const script = path.join(rootDir, "worktree-setup.mjs");
    fs.copyFileSync(scriptPath, script);
    for (const args of [[], ["source"], ["--plan"]]) {
      const output = execFileSync(process.execPath, [script, ...args], {
        cwd: rootDir,
        env: { ...process.env, PATH: "", NODE_OPTIONS: "", NODE_PATH: "" },
        encoding: "utf8",
      });
      if (args.includes("--plan")) {
        expect(JSON.parse(output)).toMatchObject({
          workload: "source",
          install: null,
          build: null,
        });
      } else {
        expect(output).toContain("Source-only");
      }
      expect(fs.readdirSync(rootDir)).toEqual(["worktree-setup.mjs"]);
    }
  });

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
    const expected = new Set([pkg.name + "...", "./packages/*..."]);
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

  it("runs cold plain-Node gateway and full plans without resolving pnpm or producing outputs", () => {
    const fixture = makePreparationFixture();
    const before = fixture.git("status", "--porcelain", "--untracked-files=all");
    const gateway = fixture.run(["gateway", "--plan"], { SETUP_TEST_VERSION: "wrong" });
    expect(gateway.status, gateway.stderr).toBe(0);
    expect(JSON.parse(gateway.stdout).install).toEqual({
      command: "pnpm",
      args: [
        "--filter",
        "./extensions/asset-build...",
        "--filter",
        "./extensions/asset-copy...",
        "--filter",
        "./extensions/isolated...",
        "--filter",
        "./packages/*...",
        "--filter",
        "openclaw...",
        "install",
        "--frozen-lockfile",
      ],
    });
    const full = fixture.run(["full", "--plan"], { SETUP_TEST_VERSION: "wrong" });
    expect(full.status, full.stderr).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      install: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
      build: { command: "pnpm", args: ["build"] },
    });
    expect(fixture.calls()).toEqual([]);
    expect(fixture.git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    fixture.assertNoOutputs();
  });

  it("accepts complete gateway cones, rejects sparse full, and preserves explicit native expansion", () => {
    const fixture = makePreparationFixture();
    fixture.git(
      "sparse-checkout",
      "set",
      "--cone",
      "scripts",
      "packages",
      "extensions",
      "src",
      ".openclaw/worktree-profiles",
    );
    expect(fs.existsSync(path.join(fixture.rootDir, "apps/android/build.gradle.kts"))).toBe(false);
    const gateway = fixture.run(["gateway", "--plan"]);
    expect(gateway.status, gateway.stderr).toBe(0);
    expect(JSON.parse(gateway.stdout).requiredInputs.sparse).toBe(true);
    const patternsBefore = fixture.git("sparse-checkout", "list");
    for (const args of [["full"], ["full", "--plan"]]) {
      const result = fixture.run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("git sparse-checkout disable");
    }
    expect(fixture.git("sparse-checkout", "list")).toBe(patternsBefore);
    expect(fixture.run(["source"]).status).toBe(0);
    expect(fixture.calls()).toEqual([]);

    fixture.git("sparse-checkout", "disable");
    expect(fs.existsSync(path.join(fixture.rootDir, "apps/android/build.gradle.kts"))).toBe(true);
    const full = fixture.run(["full", "--plan"]);
    expect(full.status, full.stderr).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      install: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
      build: { command: "pnpm", args: ["build"] },
      requiredInputs: { sparse: false },
    });
    expect(fixture.calls()).toEqual([]);
    fixture.assertNoOutputs();
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

  it("rejects excluded tracked asset owners before pnpm, even when collectors would omit them", () => {
    const fixture = makePreparationFixture();
    fixture.git(
      "sparse-checkout",
      "set",
      "--cone",
      "scripts",
      "packages",
      "extensions/isolated",
      "src",
      ".openclaw/worktree-profiles",
    );
    expect(fs.existsSync(path.join(fixture.rootDir, "extensions/asset-build/package.json"))).toBe(
      false,
    );
    for (const args of [["gateway"], ["gateway", "--plan"]]) {
      const result = fixture.run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Gateway inputs are excluded");
      expect(result.stderr).toContain("extensions/asset-build/package.json");
      expect(result.stderr).toContain("git sparse-checkout disable");
    }
    expect(fixture.calls()).toEqual([]);
    fixture.assertNoOutputs();
  });

  it("resolves linked plugin inputs before inventory discovery", () => {
    const fixture = makePreparationFixture();
    const manifest = path.join(fixture.rootDir, "extensions/isolated/package.json");
    const target = path.join(fixture.controls, "linked-package.json");
    fs.renameSync(manifest, target);
    fs.symlinkSync(target, manifest, "file");

    const valid = fixture.run(["gateway", "--plan"]);
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout).install.args).toContain("./extensions/isolated...");
    expect(fixture.calls()).toEqual([]);

    fs.unlinkSync(target);
    for (const args of [["gateway", "--plan"], ["gateway"]]) {
      const result = fixture.run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Tracked preparation inputs are missing");
      expect(result.stderr).toContain("extensions/isolated/package.json");
      expect(fs.readlinkSync(manifest)).toBe(target);
      expect(fs.existsSync(target)).toBe(false);
    }
    expect(fixture.calls()).toEqual([]);
    fixture.assertNoOutputs();
  });

  it.each([
    { workload: "gateway", missing: "extensions/isolated/index.ts" },
    { workload: "gateway", missing: "extensions/isolated" },
    { workload: "full", missing: "extensions/isolated/index.ts" },
    { workload: "full", missing: "extensions/isolated" },
  ])(
    "rejects missing tracked $missing before inventory discovery or pnpm for $workload",
    ({ workload, missing }) => {
      const fixture = makePreparationFixture();
      // This deletes only a future test-owned fixture input, never retained source.
      fs.rmSync(path.join(fixture.rootDir, missing), { recursive: true });
      for (const args of [[workload], [workload, "--plan"]]) {
        const result = fixture.run(args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Tracked preparation inputs are missing");
        expect(result.stderr).toContain("extensions/isolated/index.ts");
        if (missing === "extensions/isolated") {
          expect(result.stderr).toContain("extensions/isolated/package.json");
          expect(result.stderr).toContain("extensions/isolated/openclaw.plugin.json");
        }
      }
      expect(fixture.calls()).toEqual([]);
      fixture.assertNoOutputs();
    },
  );
});

// These are subprocess/ordering regressions. Recorders never install packages,
// prove pnpm closure, build the Gateway, or establish graph/volume isolation.
describe.each(["gateway", "full"])("%s preparation execution boundaries", (workload) => {
  it("rejects the wrong target pnpm before querying its store or installing", () => {
    const fixture = makePreparationFixture();
    const result = fixture.run([workload], { SETUP_TEST_VERSION: "0.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected repository pnpm");
    expect(fixture.calls().map((call) => call.args)).toEqual([["--version"]]);
    fixture.assertNoOutputs();
  });

  it("rejects a nonabsolute store before install", () => {
    const fixture = makePreparationFixture();
    const result = fixture.run([workload], { SETUP_TEST_STORE: "relative/store" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same volume");
    expect(fixture.calls().map((call) => call.args)).toEqual([["--version"], ["store", "path"]]);
    fixture.assertNoOutputs();
  });

  it("rejects a simulated foreign-volume store before install", () => {
    const fixture = makePreparationFixture();
    const store = path.join(fixture.controls, "foreign-store");
    fs.mkdirSync(store);
    const preload = path.join(fixture.controls, "foreign-device.mjs");
    // Simulate only st_dev for this sentinel path; no mount or shared fs mutation.
    fs.writeFileSync(
      preload,
      [
        'import fs from "node:fs";',
        "const original = fs.statSync;",
        "fs.statSync = function (target, ...args) {",
        "  const stat = original.call(this, target, ...args);",
        "  if (target === " + JSON.stringify(store) + ") { stat.dev += 1; }",
        "  return stat;",
        "};",
      ].join("\n"),
    );
    const result = fixture.run([workload], { SETUP_TEST_STORE: store }, [
      "--import",
      pathToFileURL(preload).href,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same volume");
    expect(fixture.calls().map((call) => call.args)).toEqual([["--version"], ["store", "path"]]);
    fixture.assertNoOutputs();
  });

  it.each(["node_modules", "node_modules/.pnpm", "packages/support/node_modules", "dist"])(
    "rejects linked %s before invoking pnpm and preserves its target",
    (relative) => {
      const fixture = makePreparationFixture();
      const target = path.join(fixture.controls, "retained");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
      const link = path.join(fixture.rootDir, relative);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      const result = fixture.run([workload]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("symbolic link");
      expect(fixture.calls()).toEqual([]);
      expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("unchanged");
      expect(fs.readdirSync(target)).toEqual(["sentinel"]);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    },
  );

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

  it("propagates install failure without starting a build", () => {
    const fixture = makePreparationFixture();
    const result = fixture.run([workload], { SETUP_TEST_INSTALL_EXIT: "23" });
    expect(result.status, result.stderr).toBe(23);
    const calls = fixture.calls();
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.kind)).toEqual(["pnpm", "pnpm", "pnpm"]);
    expect(calls.at(-1)?.args).toContain("install");
    expect(calls.at(-1)?.args).toContain("--frozen-lockfile");
    fixture.assertNoOutputs();
  });

  it("propagates selected-build failure after a successful recorder install", () => {
    const fixture = makePreparationFixture();
    const result = fixture.run([workload], { SETUP_TEST_BUILD_EXIT: "29" });
    expect(result.status, result.stderr).toBe(29);
    const calls = fixture.calls();
    expect(calls).toHaveLength(4);
    assert.ok(calls[2]);
    expect(calls[2].args).toContain("install");
    expect(calls[3]).toMatchObject(
      workload === "gateway"
        ? { kind: "gateway-build", args: ["qaRuntime"] }
        : { kind: "pnpm", args: ["build"] },
    );
    fixture.assertNoOutputs();
  });

  it("reaches only the selected build after successful recorder install (positive control)", () => {
    const fixture = makePreparationFixture();
    const result = fixture.run([workload]);
    expect(result.status, result.stderr).toBe(0);
    const calls = fixture.calls();
    expect(calls).toHaveLength(4);
    assert.ok(calls[0]);
    assert.ok(calls[1]);
    assert.ok(calls[2]);
    expect(calls[0].args).toEqual(["--version"]);
    expect(calls[1].args).toEqual(["store", "path"]);
    expect(calls[2].kind).toBe("pnpm");
    expect(calls[2].args).toContain("install");
    expect(calls[2].args).toContain("--frozen-lockfile");
    expect(calls[2].args).not.toContain("--ignore-scripts");
    expect(calls[3]).toMatchObject(
      workload === "gateway"
        ? { kind: "gateway-build", args: ["qaRuntime"] }
        : { kind: "pnpm", args: ["build"] },
    );
    if (workload === "full") {
      expect(calls[2].args).toEqual(["install", "--frozen-lockfile"]);
    }
    for (const call of calls) {
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(fixture.rootDir));
    }
    fixture.assertNoOutputs();
  });
});
