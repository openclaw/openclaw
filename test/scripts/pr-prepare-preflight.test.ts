import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";
import { copyPrWrapperSources } from "./pr-wrapper.test-support.js";

const repoRoot = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itPosix = process.platform === "win32" ? it.skip : it;

function runGatesBash(script: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = { ...process.env, ...options.env };
  delete env.OPENCLAW_PR_GATES_REMOTE;
  delete env.OPENCLAW_TESTBOX;
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; source "$1"\n${script}`,
      "pr-gates-preflight",
      join(repoRoot, "scripts/pr-lib/gates.sh"),
    ],
    {
      encoding: "utf8",
      env: { ...env, ...options.env },
    },
  );
}

describe("resolve_pr_gates_remote_mode", () => {
  it.each([
    { mode: undefined, hosted: undefined, code: 0, output: "local" },
    { mode: "", hosted: "1", code: 0, output: "local" },
    { mode: "testbox", hosted: undefined, code: 0, output: "testbox" },
    { mode: "crabbox-aws", hosted: undefined, code: 0, output: "crabbox-aws" },
    { mode: "github", hosted: undefined, code: 0, output: "github" },
    {
      mode: "azure",
      hosted: undefined,
      code: 1,
      output: "Unsupported OPENCLAW_PR_GATES_REMOTE=azure",
    },
    ...["testbox", "crabbox-aws", "github"].map((mode) => ({
      mode,
      hosted: "1",
      code: 2,
      output: "conflicts with OPENCLAW_TESTBOX=1",
    })),
  ])("resolves gate mode $mode with hosted=$hosted", ({ mode, hosted, code, output }) => {
    const result = runGatesBash(
      hosted === "1" && mode ? "prepare_gates 424242" : "resolve_pr_gates_remote_mode",
      {
        env: { OPENCLAW_PR_GATES_REMOTE: mode, OPENCLAW_TESTBOX: hosted },
      },
    );
    expect(result.status).toBe(code);
    if (code === 0) {
      expect(result.stdout.trim()).toBe(output);
    } else {
      expect(result.stderr).toContain(output);
    }
  });
});

describe("scripts/pr prepare mode preflight", () => {
  itPosix(
    "rejects invalid gate modes before prepare observations, locks, or evidence retirement",
    () => {
      const root = tempDirs.make("openclaw-pr-gate-preflight-");
      copyPrWrapperSources(root);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const env = {
        HOME: root,
        TMPDIR: root,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GH_REPO: "fixture/repo",
      };
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git("init", "-q");
      const reviewRoot = join(root, ".worktrees/pr-123");
      const head = "a".repeat(40);
      const review = validReview(head);
      review.pr.number = 123;
      review.recommendation = "READY FOR /prepare-pr";
      review.issueValidation.status = "valid";
      writeReviewArtifacts(reviewRoot, review, { prNumber: 123, headSha: head });
      const evidenceRoot = join(reviewRoot, ".local");
      const evidence = join(evidenceRoot, "gates.env");
      writeFileSync(evidence, "previous exact-head proof\n");
      const originalArtifacts = readdirSync(evidenceRoot);
      const ghCalls = join(root, "gh-calls");
      writeFileSync(
        join(bin, "gh"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PR_TEST_GH_CALLS"\nexit 99\n',
      );
      chmodSync(join(bin, "gh"), 0o755);
      for (const args of [
        ["prepare-push", "123", "--resume-crabbox-run"],
        ["prepare-push", "123", "--resume-crabbox-run", "0"],
        ["prepare-push", "123", "--resume-crabbox-run", "01"],
        ["prepare-push", "123", "--resume-crabbox-run", "9007199254740992"],
        ["prepare-push", "123", "--resume-crabbox-run", "99", "extra"],
        ["prepare-push", "123", "--run-id", "run_fake"],
        ["ci-dispatch", "123", "--backend", "crabbox", "--pending-gates"],
      ]) {
        const result = spawnSync(join(root, "scripts/pr"), args, {
          cwd: root,
          encoding: "utf8",
          env: { ...env, PR_TEST_GH_CALLS: ghCalls },
        });
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expect(existsSync(ghCalls)).toBe(false);
        expect(readFileSync(evidence, "utf8")).toBe("previous exact-head proof\n");
        expect(readdirSync(evidenceRoot)).toEqual(originalArtifacts);
        expect(git("for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks")).toBe(
          "",
        );
      }
      for (const command of ["prepare-run", "prepare-gates", "prepare-push"]) {
        for (const scenario of [
          {
            mode: "github",
            hosted: "1",
            diagnostic: "conflicts with OPENCLAW_TESTBOX=1",
            status: 2,
          },
          {
            mode: "unsupported",
            hosted: "",
            diagnostic: "Unsupported OPENCLAW_PR_GATES_REMOTE",
            status: 1,
          },
        ]) {
          const result = spawnSync(join(root, "scripts/pr"), [command, "123"], {
            cwd: root,
            encoding: "utf8",
            env: {
              ...env,
              OPENCLAW_PR_GATES_REMOTE: scenario.mode,
              OPENCLAW_TESTBOX: scenario.hosted,
              PR_TEST_GH_CALLS: ghCalls,
            },
          });
          expect(result.status, result.stdout + result.stderr).toBe(scenario.status);
          expect(result.stderr).toContain(scenario.diagnostic);
          expect(existsSync(ghCalls)).toBe(false);
          expect(readFileSync(evidence, "utf8")).toBe("previous exact-head proof\n");
          expect(readdirSync(evidenceRoot)).toEqual(originalArtifacts);
          expect(
            git("for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks"),
          ).toBe("");
        }
      }
    },
  );
});
