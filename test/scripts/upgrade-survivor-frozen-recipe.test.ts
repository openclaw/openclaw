import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUpgradeSurvivorConfigStepsForBaseline } from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as io from "./upgrade-survivor-shard.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const repo = resolve(".");
const specimen = "scripts/e2e/lib/upgrade-survivor/config-recipe/tools-tool-search.json";
const flag = "OPENCLAW_FROZEN_UPGRADE_SURVIVOR_TOOL_SEARCH_RECIPE";
afterEach(() => vi.unstubAllEnvs());
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

function fixture(present: boolean, skillSplit = false) {
  const root = temps.make("survivor-frozen-recipe-");
  const target = join(root, "target");
  mkdirSync(target);
  // An older main version can contain the migration while a newer frozen
  // release version predates it: version ordering cannot select this coverage.
  io.writeJson(join(target, "package.json"), { version: present ? "2026.9.6" : "2026.9.7" });
  if (present) {
    addSpecimen(target);
  }
  if (skillSplit) {
    for (const path of [
      "src/config/skill-library-tool-split-migration.ts",
      "src/commands/doctor/shared/legacy-config-migrations.runtime.tool-names.ts",
    ]) {
      mkdirSync(join(target, path, ".."), { recursive: true });
      writeFileSync(join(target, path), readFileSync(path));
    }
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "commit.gpgsign", "false");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-qm", "recipe fixture");
  const sha = git("rev-parse", "HEAD");
  const env = {
    HARNESS_ROOT_DIR: repo,
    ROOT_DIR: target,
    OPENCLAW_SELECTED_SHA: sha,
    OPENCLAW_TOOLING_SHA: "a".repeat(40),
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
  };
  const select = (extra = {}) => run(root, "bash", ["-c", selection], { ...env, ...extra });
  return { root, target, select };
}

function recipe(mode: string) {
  vi.stubEnv(flag, mode);
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL", "stable");
  return resolveUpgradeSurvivorConfigStepsForBaseline("base", "2026.9.6");
}

function checkSearch(root: string, toolSearch: unknown, stage = "survival") {
  const config = join(root, "config.json");
  const coverage = join(root, "coverage.json");
  io.writeJson(config, { tools: { toolSearch } });
  io.writeJson(coverage, { acceptedIntents: ["tool-search"] });
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
  it.each([false, true])(
    "retains skill allowlist coverage for migration=%s with omissions disabled",
    (split) => {
      const f = fixture(false, split);
      const mode = split ? "current" : "preserve";
      if (!split) {
        // A dirty addition must not invent a migration for the selected commit.
        const path = "src/config/skill-library-tool-split-migration.ts";
        mkdirSync(join(f.target, path, ".."), { recursive: true });
        writeFileSync(join(f.target, path), readFileSync(path));
      }
      const selected = f.select({ OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "0" });
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toContain(
        "OPENCLAW_FROZEN_UPGRADE_SURVIVOR_SKILL_LIBRARY_MODE=" + mode,
      );
      const config = join(f.root, "skill-config.json");
      const coverage = join(f.root, "skill-coverage.json");
      io.writeJson(coverage, { acceptedIntents: ["skill-library-split"] });
      const allowed = split
        ? ["read", "skill_workshop", "skill_library"]
        : ["read", "skill_workshop"];
      io.writeJson(config, {
        tools: { allow: allowed },
        ...(split ? { meta: { migrations: { skillLibraryToolSplit: true } } } : {}),
      });
      const env = {
        OPENCLAW_CONFIG_PATH: config,
        OPENCLAW_UPGRADE_SURVIVOR_CONFIG_COVERAGE_JSON: coverage,
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
        OPENCLAW_FROZEN_UPGRADE_SURVIVOR_SKILL_LIBRARY_MODE: mode,
      };
      const args = ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", "assert-config"];
      const checked = run(f.root, process.execPath, args, env);
      expect(checked.status, checked.stderr).toBe(0);
      io.writeJson(config, { tools: { allow: ["read"] } });
      expect(run(f.root, process.execPath, args, env).status).not.toBe(0);
    },
  );
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
    const oldRecipe = recipe("absent");
    const newRecipe = recipe("current");
    expect(newRecipe).toContainEqual(expect.objectContaining({ intent: "tool-search" }));
    expect(oldRecipe).toEqual(newRecipe.filter(({ id }) => id !== "tools-tool-search"));
    expect(checkSearch(newer.root, { mode: "code", codeTimeoutMs: 5000 }, "baseline").status).toBe(
      0,
    );
    for (const value of [{ mode: "tools", enabled: false }, undefined]) {
      expect(checkSearch(newer.root, value).status).not.toBe(0);
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
