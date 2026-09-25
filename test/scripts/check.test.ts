// Exercise the aggregate CLI and its real ratchet children; other lanes are recorded, not run.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../scripts/check.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createProvisionIsolationFixture } from "./pr-provision-isolation.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const tooling = process.cwd();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const posix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const root = realpathSync(dirs.make("check-comparison-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const isolation = createProvisionIsolationFixture(root, repo);
  const state = path.join(repo, ".local/pr-state");
  mkdirSync(state, { recursive: true });
  const config = path.join(state, "openclaw.json");
  writeFileSync(config, "{}\n");
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_PR_GATES_REMOTE: "",
    OPENCLAW_TESTBOX: "",
    PATH: isolation.path(process.env.PATH ?? ""),
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(repo, "src"));
  mkdirSync(path.join(repo, "config"));
  writeFileSync(path.join(repo, ".gitignore"), ".local/\n");
  writeFileSync(
    path.join(repo, ".oxlintrc.json"),
    JSON.stringify({
      overrides: [{ files: ["**/*.ts"], rules: { "max-lines": ["error", { max: 3 }] } }],
    }),
  );
  writeFileSync(path.join(repo, "config/max-lines-baseline.txt"), "");
  writeFileSync(path.join(repo, "config/assertion-safety-baseline.txt"), "");
  writeFileSync(path.join(repo, "config/env-var-count-budget.txt"), "0\n");
  const source = (lines: number) =>
    Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
  writeFileSync(path.join(repo, "src/inherited.ts"), source(3));
  git("add", ".");
  git("commit", "-qm", "old tracked main");
  const stale = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", stale);
  writeFileSync(path.join(repo, "src/inherited.ts"), source(5));
  git("add", ".");
  git("commit", "-qm", "integrated main growth");
  const integrated = git("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "src/candidate.ts"), source(3));
  git("add", ".");
  git("commit", "-qm", "candidate");
  const head = git("rev-parse", "HEAD");
  const events = path.join(root, "commands");
  writeFileSync(events, "");
  writeFileSync(
    path.join(isolation.bin, "pnpm"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${quote(events)}
case "$1" in
  check) shift; exec node --import ${quote(tooling + "/scripts/tsx.mjs")} ${quote(tooling + "/scripts/check.mts")} "$@" ;;
  check:line-cap-ratchet) script=check-line-cap-ratchet.mts ;;
  check:max-lines-ratchet) script=check-max-lines-ratchet.mts ;;
  check:assertion-safety) script=check-assertion-safety-ratchet.mts ;;
  *) exit 0 ;;
esac
shift
exec node --import ${quote(tooling + "/scripts/tsx.mjs")} ${quote(tooling + "/scripts/")}"$script" "$@"
`,
    { mode: 0o755 },
  );
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      [
        ...isolation.nodeArgs,
        "--import",
        tooling + "/scripts/tsx.mjs",
        tooling + "/scripts/check.mts",
        ...args,
      ],
      { cwd: repo, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000 },
    );
  const commands = () => readFileSync(events, "utf8").trim().split("\n").filter(Boolean);
  const reset = () => writeFileSync(events, "");
  const native = () => {
    writeFileSync(path.join(repo, ".local/pr-meta.env"), "PR_NUMBER=42\n");
    const script = [
      "set -euo pipefail",
      `source ${quote(tooling + "/scripts/pr-lib/common.sh")}`,
      `source ${quote(tooling + "/scripts/pr-lib/gates.sh")}`,
      `enter_worktree() { PR_MAIN_SHA=${quote(integrated)}; }`,
      "refresh_prep_branch_for_reviewed_head() { :; }",
      "checkout_prep_branch() { :; }",
      "require_prepared_review() { :; }",
      "prepare_local_gate_workspace() { :; }",
      // Mutate ambient main after capture. Neither shell global nor tracking ref may select comparison.
      `run_quiet_logged() { shift 2; if [ "$2" = build ]; then PR_MAIN_SHA=${quote(stale)}; git update-ref refs/remotes/origin/main ${quote(stale)}; fi; "$@"; }`,
      "prepare_gates 42",
    ].join("\n");
    return spawnSync("/bin/bash", ["-c", script], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  };
  const assertPrivate = () => {
    const witnesses = readdirSync(isolation.binding.directory).filter((name) =>
      name.startsWith("preflight-"),
    );
    expect(witnesses.length).toBeGreaterThan(0);
    for (const file of witnesses) {
      expect(
        JSON.parse(readFileSync(path.join(isolation.binding.directory, file), "utf8")),
      ).toMatchObject({
        databasePath: isolation.binding.databasePath,
        realParent: isolation.binding.directory,
      });
    }
    const opens = readFileSync(isolation.observations, "utf8").trim();
    expect(opens).toBe(""); // These checks have no application-state consumer.
  };
  return {
    repo,
    git,
    stale,
    integrated,
    head,
    source,
    run,
    native,
    commands,
    reset,
    assertPrivate,
  };
}

posix("scripts/check captured comparison", () => {
  it("prints help and rejects unknown, missing, mutable, unavailable and duplicate bases before any child", () => {
    const f = fixture();
    const help = f.run(["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("--base <commit>");
    for (const args of [
      ["--bogus"],
      ["bogus", "--help"],
      ["--base"],
      ["--base", ""],
      ["--base", "origin/main"],
      ["--base", "f".repeat(40)],
      ["--base", f.integrated, "--base", f.stale],
    ]) {
      const result = f.run(args);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).not.toContain("[check]");
    }
    expect(f.commands()).toEqual([]);
    f.assertPrivate();
  });

  it("runs actual ratchets against the captured commit despite stale/moving origin/main and still rejects candidate growth", () => {
    const f = fixture();
    const defaultRun = f.run([]);
    expect(defaultRun.status, defaultRun.stderr).toBe(1);
    expect(defaultRun.stderr).toContain("src/inherited.ts: 3 -> 5");
    expect(f.commands()).not.toContain("tsgo:prod");
    f.reset();
    const captured = f.run(["--base", f.integrated]);
    expect(captured.status, captured.stdout + captured.stderr).toBe(0);
    for (const guard of [
      "check:line-cap-ratchet",
      "check:max-lines-ratchet",
      "check:assertion-safety",
    ]) {
      expect(f.commands()).toContain(`${guard} --base ${f.integrated}`);
    }
    expect(f.commands()).toContain("tsgo:prod");
    expect(f.commands()).toContain("format:check");
    // Give ambient main the regression, while the captured comparison remains unchanged.
    writeFileSync(path.join(f.repo, "src/candidate.ts"), f.source(4));
    f.git("add", ".");
    f.git("commit", "-qm", "candidate regression");
    f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
    f.reset();
    const regressed = f.run(["--base", f.integrated]);
    expect(regressed.status, regressed.stderr).toBe(1);
    expect(regressed.stderr).toContain("src/candidate.ts: 3 -> 4");
    expect(regressed.stderr).not.toContain("src/inherited.ts:");
    expect(f.commands()).not.toContain("tsgo:prod");
    f.assertPrivate();
  });

  it("native gates forward the private main checkpoint through aggregate children before a head-bound stamp", () => {
    const f = fixture();
    const result = f.native();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.commands()).toContain(`check --base ${f.integrated}`);
    expect(f.commands()).toContain(`check:line-cap-ratchet --base ${f.integrated}`);
    expect(readFileSync(path.join(f.repo, ".local/gates.env"), "utf8")).toContain(
      `FULL_GATES_HEAD_SHA=${f.head}`,
    );
    expect(f.git("rev-parse", "origin/main")).toBe(f.stale);
    expect(f.commands().at(-1)).toBe("test");
    const stamp = readFileSync(path.join(f.repo, ".local/gates.env"), "utf8");
    writeFileSync(path.join(f.repo, "src/candidate.ts"), f.source(4));
    f.git("add", ".");
    f.git("commit", "-qm", "native candidate regression");
    f.reset();
    const failed = f.native();
    expect(failed.status, failed.stderr).toBe(1);
    expect(failed.stderr).toContain("src/candidate.ts: 3 -> 4");
    expect(f.commands()).not.toContain("test");
    expect(readFileSync(path.join(f.repo, ".local/gates.env"), "utf8")).toBe(stamp);
    f.assertPrivate();
  });
});

describe("scripts/check managed command", () => {
  it("preserves the managed runner result", async () => {
    const calls: Array<{ args: string[]; bin: string }> = [];
    const result = await runCommand({ args: ["lint"], name: "lint" }, async (options) => {
      calls.push(options);
      return 23;
    });
    expect(calls).toEqual([{ args: ["lint"], bin: "pnpm" }]);
    expect(result).toMatchObject({ name: "lint", status: 23 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
