import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canSkipNpmLockSetup } from "../../scripts/ci-npm-lock-admission.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterAll);
const root = process.cwd();
let cwd: string;
let base: string;
let harness: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (file: string, text = "fixture\n") => {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), text);
};
const commit = () => {
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
};
const skip = () => canSkipNpmLockSetup({ cwd, base });

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
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(cwd, file));
    mkdirSync(path.dirname(path.join(harness, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(harness, file));
  }
  copyFileSync(
    path.join(root, "scripts/ci-npm-lock-admission.mjs"),
    path.join(harness, "scripts/ci-npm-lock-admission.mjs"),
  );
  write(
    "package.json",
    JSON.stringify({
      scripts: {
        "deps:npm-lock:check:changed": "node scripts/generate-npm-package-lock.mjs --changed",
      },
    }),
  );
  write("packages/.gitkeep", "");
  write("src/example.ts");
  write("extensions/example/package.json", "{}");
  commit();
  base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", base);
});
afterEach(() => {
  git("reset", "--hard", base);
  git("clean", "-fd");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", base);
});

describe("npm lock setup admission", () => {
  it("skips dependency setup for committed source-only changes without installed packages", () => {
    write("src/example.ts", "changed\n");
    commit();
    expect(skip()).toBe(true);
    expect(
      execFileSync(process.execPath, [path.join(harness, "scripts/ci-npm-lock-admission.mjs")], {
        cwd,
        env: { ...process.env, CHECKOUT_BASE_SHA: base, HISTORICAL_TARGET: "false" },
        encoding: "utf8",
      }),
    ).toBe("skip=true\n");
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
  it("includes staged and unstaged manifest changes", () => {
    write("extensions/example/package.json", '{"private":true}');
    expect(skip()).toBe(false);
    git("add", ".");
    expect(skip()).toBe(false);
  });
  it("retains checks for deleted and renamed manifests", () => {
    git("mv", "extensions/example/package.json", "extensions/example/old.json");
    commit();
    expect(skip()).toBe(false);
  });
  it("retains unknown command and selector contracts", () => {
    write("package.json", '{"scripts":{"deps:npm-lock:check:changed":"custom"}}');
    expect(skip()).toBe(false);
    git("checkout", "--", "package.json");
    write("scripts/changed-lanes.mts", "// different historical implementation\n");
    commit();
    // Even when comparing this revision to itself, contract mismatch must run.
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/ci-ratchet-base", head);
    expect(canSkipNpmLockSetup({ cwd, base: head })).toBe(false);
  });
  it("retains malformed inventories even when the invalid manifest is unchanged", () => {
    write("extensions/example/package.json", "invalid JSON");
    commit();
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/ci-ratchet-base", head);
    expect(canSkipNpmLockSetup({ cwd, base: head })).toBe(false);
  });
  it("handles a merge head using the generator's triple-dot scope", () => {
    git("checkout", "-b", "side", base);
    write("src/side.ts");
    commit();
    git("checkout", "--detach", base);
    write("src/main.ts");
    commit();
    git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "merge", "side");
    expect(skip()).toBe(true);
  });
  it.each([
    ["src/example.ts", true],
    ["extensions/example/package.json", false],
  ])("uses the generator's two-dot fallback in a depth-one checkout: %s", (file, expected) => {
    write(file, file.endsWith(".json") ? '{"private":true}' : "changed\n");
    commit();
    const shallow = temps.make("npm-lock-shallow-");
    const run = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: shallow,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    run("clone", "--quiet", "--depth=1", pathToFileURL(cwd).href, ".");
    run("fetch", "--quiet", "--depth=1", "origin", `${base}:refs/remotes/origin/ci-ratchet-base`);
    expect(run("rev-parse", "--is-shallow-repository")).toBe("true");
    expect(() => run("diff", `${base}...HEAD`)).toThrow("no merge base");
    expect(
      execFileSync(process.execPath, [path.join(harness, "scripts/ci-npm-lock-admission.mjs")], {
        cwd: shallow,
        env: { ...process.env, CHECKOUT_BASE_SHA: base, HISTORICAL_TARGET: "false" },
        encoding: "utf8",
      }),
    ).toBe(`skip=${expected}\n`);
  });
  it("matches the generator's fallback for disconnected identical trees", () => {
    git("checkout", "--orphan", "unrelated");
    commit();
    expect(skip()).toBe(true);
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
});
