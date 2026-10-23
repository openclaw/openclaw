import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { canSkipNpmLockSetup } from "../../scripts/ci-npm-lock-admission.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterAll);
const root = process.cwd();
const manifest = "extensions/example/package.json";
let cwd: string;
let base: string;
let harness: string;
let commitNumber = 0;
const gitAt = (dir: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const git = (...args: string[]) => gitAt(cwd, ...args);
const write = (file: string, text = "fixture\n") => {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), text);
};
const change = (file: string, content = "changed\n") => {
  write(file, content);
  commit();
};
const commit = () => {
  git("add", ".");
  // Identical orphan trees must stay distinct even when Git timestamps coincide.
  git("-c", "commit.gpgsign=false", "commit", "-qm", `fixture ${commitNumber++}`);
};
const skip = () => canSkipNpmLockSetup({ cwd, base });
const runAdmission = (directory = cwd) =>
  execFileSync(process.execPath, [path.join(harness, "scripts/ci-npm-lock-admission.mjs")], {
    cwd: directory,
    env: { ...process.env, CHECKOUT_BASE_SHA: base, HISTORICAL_TARGET: "false" },
    encoding: "utf8",
  });
const copy = (file: string, directory: string) => {
  mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  copyFileSync(path.join(root, file), path.join(directory, file));
};

beforeAll(() => {
  cwd = temps.make("npm-lock-admission-");
  harness = temps.make("npm-lock-harness-");
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  for (const file of [
    "scripts/generate-npm-package-lock.mjs",
    "scripts/generate-npm-package-lock.mts",
    "scripts/changed-lanes.mts",
    "scripts/lib/merge-head-diff-base.mjs",
  ]) {
    for (const directory of [cwd, harness]) {
      copy(file, directory);
    }
  }
  copy("scripts/ci-npm-lock-admission.mjs", harness);
  const command = "node scripts/generate-npm-package-lock.mjs --changed";
  write("package.json", JSON.stringify({ scripts: { "deps:npm-lock:check:changed": command } }));
  write("packages/.gitkeep", "");
  write("src/example.ts");
  write(manifest, "{}");
  commit();
  base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", base);
});
afterEach(() => {
  git("reset", "--hard", base);
  git("clean", "-fd");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", base);
});

it("skips dependency setup for committed source-only changes without installed packages", () => {
  change("src/example.ts");
  expect(skip()).toBe(true);
  expect(runAdmission()).toBe("skip=true\n");
});
it("keeps full sweeps, historical targets, and invalid or mismatched base refs", () => {
  expect(canSkipNpmLockSetup({ cwd })).toBe(false);
  expect(canSkipNpmLockSetup({ cwd, base, historical: true })).toBe(false);
  expect(canSkipNpmLockSetup({ cwd, base: "missing" })).toBe(false);
  git("update-ref", "-d", "refs/remotes/origin/ci-ratchet-base");
  expect(skip()).toBe(false);
});
it("keeps every conservative policy input even when untracked", () => {
  for (const file of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "ui/package.json",
    "extensions/new/package-lock.json",
    "packages/changed.ts",
    "scripts/helper.mjs",
    ".github/workflows/other.yml",
    "patches/fix.patch",
    "extensions/example/local.tgz",
  ]) {
    write(file);
    expect(skip(), file).toBe(false);
    git("clean", "-fd");
  }
});
it.each(["modified", "renamed"])("retains checks for %s manifests", (mode) => {
  if (mode === "modified") {
    write(manifest, '{"private":true}');
    expect(skip()).toBe(false);
    git("add", ".");
  } else {
    git("mv", manifest, "extensions/example/old.json");
    commit();
  }
  expect(skip()).toBe(false);
});
it("retains unknown commands", () => {
  write("package.json", '{"scripts":{"deps:npm-lock:check:changed":"custom"}}');
  expect(skip()).toBe(false);
});
it.each([
  ["scripts/changed-lanes.mts", "// different historical implementation\n"],
  [manifest, "invalid JSON"],
])("retains invalid %s even when comparing a revision to itself", (file, content) => {
  change(file, content);
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", head);
  expect(canSkipNpmLockSetup({ cwd, base: head })).toBe(false);
});

it.each(["merge", "disconnected"])("matches the generator's %s diff scope", (graph) => {
  if (graph === "merge") {
    git("checkout", "-b", "side", base);
    change("src/side.ts", "fixture\n");
    git("checkout", "--detach", base);
    change("src/main.ts", "fixture\n");
    git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "merge", "side");
  } else {
    git("checkout", "--orphan", "unrelated");
    commit();
    expect(git("rev-parse", "HEAD")).not.toBe(base);
    expect(() => git("merge-base", base, "HEAD")).toThrow();
  }
  expect(skip()).toBe(true);
});
it.each([
  ["src/example.ts", true],
  [manifest, false],
])("uses the generator's two-dot fallback in a depth-one checkout: %s", (file, expected) => {
  change(file, file.endsWith(".json") ? '{"private":true}' : "changed\n");
  const shallow = temps.make("npm-lock-shallow-");
  const run = (...args: string[]) => gitAt(shallow, ...args);
  run("clone", "--quiet", "--depth=1", pathToFileURL(cwd).href, ".");
  run("fetch", "--quiet", "--depth=1", "origin", `${base}:refs/remotes/origin/ci-ratchet-base`);
  expect(run("rev-parse", "--is-shallow-repository")).toBe("true");
  expect(() => run("diff", `${base}...HEAD`)).toThrow("no merge base");
  expect(runAdmission(shallow)).toBe(`skip=${expected}\n`);
});
it("wires the dependency-free decision before conditional setup", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const shard = workflow.split("  check-shard:")[1]?.split("\n  check-test-types-core:")[0] ?? "";
  const admission = shard.indexOf("node .ci-harness/scripts/ci-npm-lock-admission.mjs");
  expect(admission).toBeGreaterThanOrEqual(0);
  expect(admission).toBeLessThan(shard.indexOf("- name: Setup Node environment"));
  expect(shard).toContain("if: steps.npm-lock-scope.outputs.skip != 'true'");
  expect(shard).toContain(
    'pnpm deps:npm-lock:check:changed --base "$CHECKOUT_BASE_SHA" --head HEAD',
  );
});
