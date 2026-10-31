import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { canSkipNpmLockSetup } from "../../scripts/ci-npm-lock-admission.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowCondition,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

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
    "scripts/lib/npm-lock-package-selection.mjs",
    "scripts/lib/npm-lock-package-selection.d.mts",
    "scripts/lib/record-shared.mjs",
    "scripts/lib/record-shared.d.mts",
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
  vi.unstubAllEnvs();
  git("reset", "--hard", base);
  git("clean", "-fd");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", base);
});

it("skips dependency setup for committed source-only changes without installed packages", () => {
  change("src/example.ts");
  expect(skip()).toBe(true);
  expect(runAdmission()).toBe("skip=true\n");
});
it.each(["committed", "staged", "untracked"])(
  "skips canonical empty selections for %s unrelated root scripts without installed packages",
  (state) => {
    write("scripts/helper.mjs");
    if (state === "committed") {
      commit();
    } else if (state === "staged") {
      git("add", ".");
    }
    expect(skip()).toBe(true);
    expect(runAdmission()).toBe("skip=true\n");
  },
);
it("keeps full sweeps, historical targets, and invalid or mismatched base refs", () => {
  expect(canSkipNpmLockSetup({ cwd })).toBe(false);
  expect(canSkipNpmLockSetup({ cwd, base, historical: true })).toBe(false);
  expect(canSkipNpmLockSetup({ cwd, base: "missing" })).toBe(false);
  git("update-ref", "-d", "refs/remotes/origin/ci-ratchet-base");
  expect(skip()).toBe(false);
});
it("keeps each conservative path class even when untracked", () => {
  for (const file of [
    "pnpm-lock.yaml",
    "ui/package.json",
    "extensions/new/package-lock.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "patches/example.patch",
    "packages/example/index.ts",
    ".github/workflows/example.yml",
    "scripts/ci-npm-lock-admission.mjs",
    "scripts/generate-npm-package-lock.worker.mts",
    "scripts/npm-runner.mts",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/tsx.mjs",
    "scripts/lib/example.mjs",
    "scripts/e2e/example.sh",
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
it("retains root manifest changes with the canonical command unchanged", () => {
  const packageJson = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  change("package.json", JSON.stringify({ ...packageJson, private: true }));
  expect(skip()).toBe(false);
});
it.each(["OPENCLAW_NPM_LOCK_JOBS", "OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT"])(
  "retains even empty %s overrides",
  (name) => {
    vi.stubEnv(name, "");
    expect(skip()).toBe(false);
  },
);
it.each([
  "packages",
  "scripts/lib/npm-lock-package-selection.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/record-shared.d.mts",
])("retains incomplete %s inputs", (file) => {
  rmSync(path.join(cwd, file), { recursive: true, force: true });
  expect(skip()).toBe(false);
  expect(runAdmission()).toBe("skip=false\n");
});
it.each([
  ["scripts/changed-lanes.mts", "// different historical implementation\n"],
  ["scripts/lib/npm-lock-package-selection.mjs", "// different historical selector\n"],
  ["scripts/lib/npm-lock-package-selection.d.mts", "// different historical declaration\n"],
  ["scripts/lib/record-shared.mjs", "// different historical record guard\n"],
  ["scripts/lib/record-shared.d.mts", "// different historical record declaration\n"],
  [manifest, "invalid JSON"],
])("retains invalid %s even when comparing a revision to itself", (file, content) => {
  change(file, content);
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/ci-ratchet-base", head);
  expect(canSkipNpmLockSetup({ cwd, base: head })).toBe(false);
});

it("matches the generator's merge diff scope", () => {
  git("checkout", "-b", "side", base);
  change("src/side.ts", "fixture\n");
  git("checkout", "--detach", base);
  change("src/main.ts", "fixture\n");
  git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "merge", "side");
  expect(skip()).toBe(true);
});
it.each([
  ["src/example.ts", true],
  ["scripts/helper.mjs", true],
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
  const steps = readCiWorkflow().jobs["check-shard"].steps;
  const setup = steps.find((step: WorkflowStep) => step.id === "check_setup");
  const admission = steps.findIndex((step: WorkflowStep) => step.id === "npm-lock-scope");
  expect(admission).toBeGreaterThanOrEqual(0);
  expect(admission).toBeLessThan(steps.indexOf(setup));
  for (const decision of ["true", "false"]) {
    expect(
      evaluateWorkflowCondition(setup.if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { "npm-lock-scope": { outputs: { skip: decision }, outcome: "success" } },
      }),
    ).toBe(decision !== "true");
  }
});
