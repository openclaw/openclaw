import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as io from "./upgrade-survivor-shard.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const repo = resolve(".");
const recipe = "scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
const specimen = "scripts/e2e/lib/upgrade-survivor/config-recipe/tools-tool-search.json";
const flag = "OPENCLAW_FROZEN_UPGRADE_SURVIVOR_TOOL_SEARCH_RECIPE";
const source = readFileSync("scripts/e2e/upgrade-survivor-docker.sh", "utf8");
const policy = source.slice(
  source.indexOf("UPGRADE_SCENARIO_ARGS=()"),
  source.indexOf('if [ "$UPGRADE_TARGET_TRAIN" = extended-stable ]; then'),
);
const selection = `set -euo pipefail; source "$HARNESS_ROOT_DIR/scripts/lib/frozen-target-compat.sh"
${policy}
printf "%s\\n" "\${UPGRADE_COMPAT_ENV_ARGS[@]}"`;

function run(root: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
  return io.runProcess(command, args, { PATH: process.env.PATH, HOME: root, ...env }, 10000);
}

function addSpecimen(target: string) {
  mkdirSync(join(target, specimen, ".."), { recursive: true });
  writeFileSync(join(target, specimen), readFileSync(specimen));
}

function fixture(present: boolean) {
  const root = temps.make("survivor-frozen-recipe-");
  const target = join(root, "target");
  mkdirSync(target);
  // An older main version can contain the migration while a newer frozen
  // release version predates it: version ordering cannot select this coverage.
  io.writeJson(join(target, "package.json"), { version: present ? "2026.9.6" : "2026.9.7" });
  if (present) {
    addSpecimen(target);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    ...[
      "core.hooksPath=/dev/null",
      "commit.gpgsign=false",
      "user.name=Fixture",
      "user.email=fixture@example.invalid",
    ].flatMap((setting) => ["-c", setting]),
    "commit",
    "-qm",
    "recipe fixture\n\nCo-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>",
  );
  const sha = git("rev-parse", "HEAD");
  const env = {
    HARNESS_ROOT_DIR: repo,
    ROOT_DIR: target,
    OPENCLAW_SELECTED_SHA: sha,
    OPENCLAW_TOOLING_SHA: "a".repeat(40),
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
  };
  const select = (extra = {}) => run(root, "bash", ["-c", selection], { ...env, ...extra });
  return { root, target, select, sha };
}

function apply(root: string, mode: string) {
  io.writeExecutable(join(root, "openclaw"), "#!/bin/sh\nexit 0\n");
  const summary = join(root, "recipe.json");
  const result = run(
    root,
    process.execPath,
    [recipe, "apply", "--summary", summary, "--baseline-version", "2026.9.6"],
    { PATH: root + ":" + process.env.PATH, [flag]: mode },
  );
  expect(result.status, result.stderr).toBe(0);
  return io.readJson(summary) as {
    acceptedIntents: string[];
    steps: Array<{ id: string; command: string }>;
  };
}

function checkSearch(root: string, accepted: boolean, toolSearch: unknown, stage = "survival") {
  const config = join(root, "config.json");
  const coverage = join(root, "coverage.json");
  io.writeJson(config, { tools: { toolSearch } });
  // Isolate this assertion's input; recipe coverage retention is checked separately.
  io.writeJson(coverage, { acceptedIntents: accepted ? ["tool-search"] : [] });
  return run(
    root,
    process.execPath,
    ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", "assert-config"],
    {
      OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coverage,
      OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
    },
  );
}

describe.skipIf(process.platform === "win32")("frozen survivor Tool Search recipe", () => {
  it("selects committed coverage through the actual host policy, retaining all other recipe steps", () => {
    const old = fixture(false);
    // An uncommitted working-tree addition cannot grant selected coverage.
    addSpecimen(old.target);
    const selectedOld = old.select();
    expect(selectedOld.status, selectedOld.stderr).toBe(0);
    expect(selectedOld.stdout).toContain(flag + "=absent");
    const newer = fixture(true);
    const selectedNew = newer.select();
    expect(selectedNew.status, selectedNew.stderr).toBe(0);
    expect(selectedNew.stdout).toContain(flag + "=current");
    const oldRecipe = apply(old.root, "absent");
    const newRecipe = apply(newer.root, "current");
    expect(oldRecipe.acceptedIntents).not.toContain("tool-search");
    expect(newRecipe.acceptedIntents).toContain("tool-search");
    expect(oldRecipe.acceptedIntents).toEqual(
      newRecipe.acceptedIntents.filter((id) => id !== "tool-search"),
    );
    expect(oldRecipe.steps).toEqual(newRecipe.steps.filter(({ id }) => id !== "tools-tool-search"));
    const legacySearch = { mode: "code", codeTimeoutMs: 5000 };
    expect(checkSearch(old.root, false, legacySearch).status).toBe(0);
    expect(checkSearch(newer.root, true, legacySearch, "baseline").status).toBe(0);
    expect(checkSearch(newer.root, true, { mode: "tools" }).status).toBe(0);
    for (const value of [
      legacySearch,
      { mode: "tools", codeTimeoutMs: 5000 },
      { mode: "tools", enabled: false },
      undefined,
    ]) {
      expect(checkSearch(newer.root, true, value).status).not.toBe(0);
    }
  });

  it("refuses mismatched selected identity and keeps unqualified runs strict", () => {
    const f = fixture(false);
    const mismatch = f.select({ OPENCLAW_SELECTED_SHA: "b".repeat(40) });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout).toBe("");
    expect(mismatch.stderr).toContain("does not match");
    const current = f.select({
      OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0",
      [flag]: "absent",
    });
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toContain(flag + "=current");
  });
});
