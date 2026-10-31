import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-line-cap-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createToolingDependencyFixture,
  installLineCapToolingFixture,
} from "./tooling-dependencies.test-support.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const errors = vi.fn<typeof console.error>();
beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  errors.mockClear();
  vi.spyOn(console, "error").mockImplementation(errors);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function git(root: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function source(lines: number) {
  return Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};\n`).join("");
}

const check = (root: string, ...args: string[]) => main(root, ["--base", "HEAD", ...args]);
function write(root: string, content: number | string, file = "src/file.ts") {
  fs.writeFileSync(path.join(root, file), typeof content === "number" ? source(content) : content);
}
function expectSource(root: string, content: number | string, code: number, file = "src/file.ts") {
  write(root, content, file);
  expect(check(root)).toBe(code);
}
const expectGrowth = (file = "src/file.ts", from = 5, to = 6) =>
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining(`${file}: ${from} -> ${to} counted lines (cap 3)`),
  );

function fixture(
  lines = 5,
  severity = "warn",
  ignorePatterns: string[] = [],
  root = tempDirs.make("openclaw-line-cap-test-"),
) {
  fs.mkdirSync(path.join(root, "src"));
  const rules = { "max-lines": [severity, { max: 3, skipBlankLines: true, skipComments: true }] };
  const override = { files: ["**/*.ts"], excludeFiles: ["**/generated/**"], rules };
  write(root, JSON.stringify({ ignorePatterns, overrides: [override] }), ".oxlintrc.json");
  write(root, lines);
  git(root, "init");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

it("warns for CI growth, writes the summary, and still rejects broken source", () => {
  const root = fixture();
  const summary = path.join(root, "summary.md");
  expectSource(root, 6, 1);
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
  expect(check(root)).toBe(0);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("::warning file=src/file.ts,line=1,col=0,"),
  );
  expect(fs.readFileSync(summary, "utf8")).toContain("5 -&gt; 6 counted lines");
  expectSource(root, "export const = broken;", 1);
});

it("measures ignored repository-contained scratch while preserving explicit exclusions", () => {
  const root = fixture(5, "warn", ["src/ignored/**"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".artifacts/\n");
  const scratch = path.join(root, ".artifacts", "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  vi.stubEnv("TMPDIR", scratch);
  vi.stubEnv("TMP", scratch);
  vi.stubEnv("TEMP", scratch);
  expectSource(root, 6, 1);
  expectGrowth();
  write(root, 4);
  for (const directory of ["ignored", "generated"]) {
    fs.mkdirSync(path.join(root, "src", directory));
    fs.writeFileSync(path.join(root, "src", directory, "excluded.ts"), source(8));
  }
  errors.mockClear();
  expect(check(root)).toBe(0);
  expect(errors).not.toHaveBeenCalled();
});

it("ratchets error diagnostics in JetBrains terminals across renames, staged and untracked sources", () => {
  vi.stubEnv("TERMINAL_EMULATOR", "JetBrains-JediTerm");
  const root = fixture(5, "error");
  const scratch = tempDirs.make("openclaw-line-cap-scratch-");
  const scratchAlias = path.join(root, "scratch-alias");
  fs.symlinkSync(scratch, scratchAlias, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", scratchAlias);
  expectSource(root, source(5) + "// changed comment\n", 0);
  const renamed = "src/renamed space #%.ts";
  git(root, "mv", "src/file.ts", renamed);
  expectSource(root, source(4) + "\n/* comment\n comment */\n", 0, renamed);
  write(root, 6, renamed);
  git(root, "add", ".");
  write(root, 4, renamed);
  expect(check(root, "--staged")).toBe(1);
  expectGrowth(renamed);
  expect(check(root)).toBe(0);
  expectSource(root, 4, 1, "src/new.ts");
  expectGrowth("src/new.ts", 3, 4);
});

it("handles repaired under-cap head without relaxing the head check", () => {
  const root = fixture(2);
  write(root, "const duplicate = 1;\nconst duplicate = 2;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "broken base");
  expectSource(root, 3, 0);
  expect(errors).not.toHaveBeenCalled();
});

it("does not hydrate historical blobs for under-cap repairs in a partial clone", () => {
  const origin = fixture();
  git(origin, "config", "uploadpack.allowFilter", "true");
  write(origin, 3);
  git(origin, "commit", "-am", "repair");
  const root = path.join(tempDirs.make("openclaw-line-cap-partial-"), "clone");
  git(origin, "clone", "--filter=blob:none", pathToFileURL(origin).href, root);
  const packs = path.join(root, ".git", "objects", "pack");
  const before = fs.readdirSync(packs).filter((file) => file.endsWith(".pack"));
  expect(main(root, ["--base", "HEAD~"])).toBe(0);
  expect(fs.readdirSync(packs).filter((file) => file.endsWith(".pack"))).toEqual(before);
});

it("counts oxlint-suppressed debt without changing the source", () => {
  const root = fixture();
  const directive = "/* oxlint-disable max-lines -- inherited debt */\n";
  write(root, directive + source(5));
  git(root, "add", ".");
  git(root, "commit", "-m", "inherited suppression");
  expectSource(root, directive + source(4), 0);
  const growing = directive + source(6);
  expectSource(root, growing, 1);
  expectGrowth();
  expect(fs.readFileSync(path.join(root, "src/file.ts"), "utf8")).toBe(growing);
});

it("uses qualified oxlint instead of a stale canonical bin in a code-only worktree", () => {
  const owner = fixture(2);
  const checkout = path.join(owner, "task");
  git(owner, "worktree", "add", "--detach", checkout, "HEAD");
  const { env } = installLineCapToolingFixture(checkout);
  const bin = path.join(owner, "node_modules/.bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "oxlint"),
    '#!/usr/bin/env node\nconsole.error("STALE CANONICAL OXLINT EXECUTED"); process.exit(87);\n',
    { mode: 0o755 },
  );
  // Isolate binary selection from the package entry's loader admission.
  fs.writeFileSync(
    path.join(checkout, "scripts/probe.mjs"),
    'import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs"; await runTsxCliShim(import.meta.url, { implementation: "./check-line-cap-ratchet.mts", toolingDependencies: "line-cap-ratchet" });',
  );
  write(checkout, 3);
  git(checkout, "add", "src/file.ts");
  const result = spawnSync(process.execPath, ["scripts/probe.mjs", "--staged", "--base", "HEAD"], {
    cwd: checkout,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result, result.stderr).toMatchObject({ status: 0 });
  expect(result.stdout).toContain("Line-cap ratchet OK: 1 changed source files");
  expect(result.stderr).not.toContain("STALE CANONICAL OXLINT EXECUTED");
  expect(fs.existsSync(path.join(checkout, "node_modules"))).toBe(false);
});

function cliFixture(cliSource: string) {
  const donor = createToolingDependencyFixture(tempDirs.make("openclaw-line-cap-admission-"));
  const { env } = installLineCapToolingFixture(donor.checkout);
  const root = fixture(2, "warn", [], donor.checkout);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  donor.writePackage("tsx", "export {};", manifest.devDependencies.tsx);
  donor.writePackage("json5", "export default JSON;", manifest.dependencies.json5);
  const pkg = donor.writePackage("oxlint", cliSource, manifest.devDependencies.oxlint);
  const binManifest = {
    name: "oxlint",
    version: manifest.devDependencies.oxlint,
    type: "module",
    exports: { "./package.json": "./package.json" },
    bin: { oxlint: "index.mjs" },
  };
  write(root, 3);
  git(root, "add", "src/file.ts");
  return {
    donor,
    root,
    pkg,
    binManifest,
    run: () => {
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(binManifest));
      return spawnSync(
        process.execPath,
        ["scripts/check-line-cap-ratchet.mjs", "--staged", "--base", "HEAD"],
        {
          cwd: root,
          env: { ...env, OPENCLAW_PR_TOOLING_ROOT: donor.tooling },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
    },
  };
}

it.each([
  { stdout: "", stderr: "Cannot load oxlint native binding", status: 1 },
  { stdout: "invalid report", stderr: "Cannot load oxlint native binding", status: 1 },
  { stdout: "Invalid oxlint configuration", stderr: "", status: 1 },
  { stdout: "invalid report", stderr: "Successful child stderr", status: 0 },
])(
  "preserves failed child diagnostics for $status/$stdout/$stderr",
  ({ stdout, stderr, status }) => {
    const { root, run } = cliFixture(
      `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${status};`,
    );
    const result = run();
    expect(result.status, result.stderr).toBe(1);
    if (status !== 0) {
      expect(result.stderr).toContain(stderr || stdout);
    } else {
      expect(result.stderr).not.toContain(stderr);
      expect(result.stdout).not.toContain("Line-cap ratchet OK");
    }
    expect(result.stderr.trimEnd()).toMatch(/\[line-cap-ratchet\] FAILED \(exit 1\)$/u);
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  },
);

it.each(["bin traversal", "bin symlink"])(
  "rejects %s before executing the oxlint CLI",
  (invalid) => {
    const marker = 'console.error("UNQUALIFIED OXLINT EXECUTED"); process.exit(87);';
    const { donor, root, pkg, binManifest, run } = cliFixture(marker);
    const outside = path.join(donor.tooling, "outside-cli.mjs");
    fs.writeFileSync(outside, marker);
    if (invalid === "bin traversal") {
      binManifest.bin.oxlint = "../../outside-cli.mjs";
    } else {
      fs.symlinkSync(outside, path.join(pkg, "cli.mjs"), "file");
      binManifest.bin.oxlint = "cli.mjs";
    }
    const result = run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "The oxlint CLI bin must be a file inside its admitted package.",
    );
    expect(result.stdout + result.stderr).not.toContain("UNQUALIFIED OXLINT EXECUTED");
    expect(fs.existsSync(path.join(root, "node_modules"))).toBe(false);
  },
);
