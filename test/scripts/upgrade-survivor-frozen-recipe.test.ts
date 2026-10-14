import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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

function fixture(present: boolean) {
  const root = temps.make("survivor-frozen-recipe-");
  const target = join(root, "target");
  mkdirSync(target);
  // An older main version can contain the migration while a newer frozen
  // release version predates it: version ordering cannot select this coverage.
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ version: present ? "2026.9.6" : "2026.9.7" }),
  );
  if (present) {
    mkdirSync(join(target, specimen, ".."), { recursive: true });
    writeFileSync(join(target, specimen), readFileSync(specimen));
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "recipe fixture\n\nCo-authored-by: RomneyDa <6581799+RomneyDa@users.noreply.github.com>",
  );
  const sha = git("rev-parse", "HEAD");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    HARNESS_ROOT_DIR: repo,
    ROOT_DIR: target,
    OPENCLAW_SELECTED_SHA: sha,
    OPENCLAW_TOOLING_SHA: "a".repeat(40),
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
  };
  const select = (extra = {}) =>
    spawnSync(
      "bash",
      [
        "-c",
        [
          'set -euo pipefail; source "$HARNESS_ROOT_DIR/scripts/lib/frozen-target-compat.sh"',
          policy,
          'printf "%s\\n" "${UPGRADE_COMPAT_ENV_ARGS[@]}"',
        ].join("\n"),
      ],
      { env: { ...env, ...extra }, encoding: "utf8", timeout: 10000 },
    );
  return { root, target, select, sha };
}

function apply(root: string, mode: string) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "openclaw");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const summary = join(root, "recipe.json");
  const result = spawnSync(
    process.execPath,
    [recipe, "apply", "--summary", summary, "--baseline-version", "2026.9.6"],
    {
      env: { PATH: bin + ":" + process.env.PATH, HOME: root, [flag]: mode },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(readFileSync(summary, "utf8")) as {
    acceptedIntents: string[];
    steps: Array<{ id: string; command: string }>;
  };
}

function assertToolSearch(
  root: string,
  accepted: boolean,
  toolSearch: unknown,
  stage = "survival",
) {
  const config = join(root, "config.json");
  const coverage = join(root, "coverage.json");
  writeFileSync(config, JSON.stringify({ tools: { toolSearch } }));
  // Isolate this assertion's input; recipe coverage retention is checked separately.
  writeFileSync(coverage, JSON.stringify({ acceptedIntents: accepted ? ["tool-search"] : [] }));
  return spawnSync(
    process.execPath,
    ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", "assert-config"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        OPENCLAW_CONFIG_PATH: config,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coverage,
        OPENCLAW_UPGRADE_SURVIVOR_ASSERT_STAGE: stage,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

describe.skipIf(process.platform === "win32")("frozen survivor Tool Search recipe", () => {
  it("selects committed coverage through the actual host policy, retaining all other recipe steps", () => {
    const old = fixture(false);
    // An uncommitted working-tree addition cannot grant selected coverage.
    mkdirSync(join(old.target, specimen, ".."), { recursive: true });
    writeFileSync(join(old.target, specimen), readFileSync(specimen));
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
    expect(assertToolSearch(old.root, false, { mode: "code", codeTimeoutMs: 5000 }).status).toBe(0);
    expect(
      assertToolSearch(newer.root, true, { mode: "code", codeTimeoutMs: 5000 }, "baseline").status,
    ).toBe(0);
    expect(assertToolSearch(newer.root, true, { mode: "tools" }).status).toBe(0);
    for (const value of [
      { mode: "code", codeTimeoutMs: 5000 },
      { mode: "tools", codeTimeoutMs: 5000 },
      { mode: "tools", enabled: false },
      undefined,
    ]) {
      expect(assertToolSearch(newer.root, true, value).status).not.toBe(0);
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
