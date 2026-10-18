import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import {
  materializeNativeCompiler,
  overrideNativeFixtureExecutable,
  resolveInstalledNativeCompiler,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const sourceRoot = process.cwd();
// Keep fixture Git work bounded to the wrapper, implementation and loader closure.
const WRAPPER_FILES = collectRuntimeImportClosure(
  sourceRoot,
  ["scripts/run-tsgo.mjs", "scripts/run-tsgo.mts", "scripts/tsx.mjs"],
  { includeDynamicImports: true },
);

function createLinkedCheckoutFixture() {
  const directory = fs.realpathSync.native(roots.make("native-wrapper-worktree-"));
  const primary = path.join(directory, "primary");
  const root = path.join(directory, "linked");
  fs.mkdirSync(primary);
  // Isolate Git writes from hook-owned indexes; wrappers inherit the real environment.
  const gitEnv = createNestedGitEnv();
  delete gitEnv.GIT_COMMON_DIR;
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        `--git-dir=${path.join(primary, ".git")}`,
        `--work-tree=${primary}`,
        ...[
          `core.hooksPath=${path.join(directory, "unused-hooks")}`,
          "commit.gpgsign=false",
          "user.name=Fixture",
          "user.email=fixture@example.invalid",
        ].flatMap((config) => ["-c", config]),
        ...args,
      ],
      { cwd: primary, env: gitEnv, encoding: "utf8", timeout: 10_000 },
    );
  git(["init", "-q"]);
  writeNativeFixtureFile(primary, "package.json", '{"private":true,"type":"module"}\n');
  writeNativeFixtureFile(primary, "pnpm-workspace.yaml", "packages: []\n");
  writeNativeFixtureFile(primary, ".gitignore", "node_modules/\n.artifacts/\n");
  for (const file of WRAPPER_FILES) {
    const target = path.join(primary, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, file), target);
  }
  git(["add", "."]);
  git(["commit", "-qm", "Synthetic compiler wrapper fixture"]);
  git(["worktree", "add", "--detach", "-q", root]);
  // An ancestor install must not let the worktree's own preload skip its Git fallback.
  expect(path.relative(primary, root)).toBe(`..${path.sep}linked`);
  expect(fs.lstatSync(path.join(root, ".git")).isFile()).toBe(true);
  materializeNativeCompiler(primary, { javaScriptApi: false });
  linkCheckoutTools(primary);
  return { primary, root, git };
}

function linkCheckoutTools(root: string) {
  for (const name of ["tsx", "@openclaw/fs-safe"]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(sourceRoot, "node_modules", name), target, "junction");
  }
}

function runTsgoEntry(
  root: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; status?: number } = {},
) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/run-tsgo.mjs"), ...args], {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 25_000,
    killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(options.status ?? 0);
  return result;
}

describe("run-tsgo linked worktree entry", () => {
  it("selects its own root compiler from src while preserving relative project semantics", () => {
    const { root } = createLinkedCheckoutFixture();
    linkCheckoutTools(root);
    const native = resolveInstalledNativeCompiler();
    const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
    const compilerOptions = { types: [], noEmit: true };
    write("tsconfig.json", JSON.stringify({ compilerOptions, files: ["wrong-entry.ts"] }));
    write("wrong-entry.ts", 'export const value: number = "wrong project";\n');
    write("src/tsconfig.json", JSON.stringify({ compilerOptions, files: ["entry.ts"] }));
    write("src/entry.ts", "export const value: number = 1;\n");
    const selectionPath = path.join(root, "compiler-selection.json");
    // Record selection, then let the real compiler parse -p and check the project.
    write(
      "native-compiler.mjs",
      `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
fs.writeFileSync(${JSON.stringify(selectionPath)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
const result = spawnSync(${JSON.stringify(native)}, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
    );
    fs.chmodSync(path.join(root, "native-compiler.mjs"), 0o755);
    const launcher = path.join(root, "node_modules/.bin/tsgo");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.symlinkSync("../../native-compiler.mjs", launcher, "file");
    if (process.platform === "win32") {
      write("node_modules/.bin/tsgo.cmd", '@node "%~dp0tsgo" %*\r\n');
    }
    overrideNativeFixtureExecutable(root, launcher);
    const cwd = path.join(root, "src");
    const result = runTsgoEntry(root, ["-p", "tsconfig.json"], {
      cwd,
      env: { ...process.env, OPENCLAW_CI_STATIC_EVIDENCE: "1" },
    });
    const selected: { cwd: string; args: string[] } = JSON.parse(
      fs.readFileSync(selectionPath, "utf8"),
    );
    expect(selected.cwd).toBe(cwd);
    expect(selected.args.slice(0, 2)).toEqual(["-p", "tsconfig.json"]);
    if (process.platform !== "win32") {
      const receipts = result.stdout.trim().split("\n");
      expect(receipts).toHaveLength(2);
      const parseReceipt = (line: string) => JSON.parse(line.slice(line.indexOf(" ") + 1));
      const leaf = parseReceipt(receipts[0]!);
      const header = { version: 1, id: expect.any(String) };
      expect(leaf).toEqual({
        ...header,
        config: "tsconfig.json",
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      expect(parseReceipt(receipts[1]!)).toEqual({
        ...header,
        planned: 1,
        completed: 1,
        leaves: [leaf.id],
      });
    }
    expect(fs.lstatSync(path.join(cwd, "node_modules"), { throwIfNoEntry: false })).toBeUndefined();
  }, 30_000);

  it("refuses a missing local install through its own wrapper without creating dependency links", () => {
    const { primary, root } = createLinkedCheckoutFixture();
    const installed = runTsgoEntry(primary, ["--version"]);
    expect(installed.stdout).toMatch(/^Version \d/m);
    const modules = path.join(root, "node_modules");
    expect(fs.lstatSync(modules, { throwIfNoEntry: false })).toBeUndefined();

    const result = runTsgoEntry(root, ["--version"], { status: 1 });
    expect(result.stdout).not.toMatch(/^Version \d/m);
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[tsgo] FAILED (exit 1)");
    expect(fs.lstatSync(modules, { throwIfNoEntry: false })).toBeUndefined();
  }, 30_000);

  it("visibly skips a missing sparse project through its own wrapper before creating dependencies or outputs", () => {
    const { root, git } = createLinkedCheckoutFixture();
    git(["config", "core.sparseCheckout", "true"]);
    const result = runTsgoEntry(
      root,
      [
        "-p",
        "test/tsconfig/tsconfig.core.test.json",
        "--tsBuildInfoFile",
        ".artifacts/should-not-exist.tsbuildinfo",
      ],
      { env: { ...process.env, OPENCLAW_TSGO_SPARSE_SKIP: "1", OPENCLAW_CI_STATIC_EVIDENCE: "1" } },
    );
    expect(result.stderr).toContain("skipping sparse-missing project");
    expect(result.stderr).toContain("OPENCLAW_TSGO_SPARSE_SKIP=1");
    expect(result.stdout).not.toContain("[ci-static:tsgo:");
    expect(
      fs.lstatSync(path.join(root, "node_modules"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".artifacts"))).toBe(false);
  }, 30_000);
});
