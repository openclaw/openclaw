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
import { runGatesBash } from "./pr-prepare.test-support.js";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";
import {
  copyPrWrapperSources,
  delegatingGitFixture,
  linkPrWrapperDependencies,
} from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itPosix = process.platform === "win32" ? it.skip : it;

describe("resolve_pr_gates_remote_mode", () => {
  it.each([
    { mode: undefined, hosted: undefined, code: 0, output: "github" },
    { mode: "", hosted: "1", code: 0, output: "local" },
    { mode: "local", hosted: undefined, code: 0, output: "local" },
    { mode: "boat", hosted: undefined, code: 0, output: "boat" },
    { mode: "testbox", hosted: undefined, code: 0, output: "testbox" },
    { mode: "crabbox-aws", hosted: undefined, code: 0, output: "crabbox-aws" },
    { mode: "github", hosted: undefined, code: 0, output: "github" },
    {
      mode: "azure",
      hosted: undefined,
      code: 1,
      output: "Unsupported OPENCLAW_PR_GATES_REMOTE=azure",
    },
    ...["local", "boat", "testbox", "crabbox-aws", "github"].map((mode) => ({
      mode,
      hosted: "1",
      code: 2,
      output: "conflicts with OPENCLAW_TESTBOX=1",
    })),
  ])("resolves gate mode $mode with hosted=$hosted", ({ mode, hosted, code, output }) => {
    const result = runGatesBash(
      hosted === "1" && mode ? "prepare_gates 424242" : "resolve_pr_gates_remote_mode",
      {
        gatesOnly: true,
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
      const components = copyPrWrapperSources(root);
      linkPrWrapperDependencies(root);
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "rg"), "#!/bin/sh\necho 'Unexpected rg call' >&2\nexit 99\n", {
        mode: 0o755,
      });
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
      git("init", "-q", "-b", "main");
      git("add", "--", ...components);
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Wrapper",
      );
      git("remote", "add", "origin", root);
      git("update-ref", "refs/remotes/origin/main", "HEAD");
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
      const gitGuard = delegatingGitFixture(root, env);
      const ghCalls = join(root, "gh-calls");
      writeFileSync(
        join(bin, "gh"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PR_TEST_GH_CALLS"\nexit 99\n',
      );
      chmodSync(join(bin, "gh"), 0o755);
      const expectUntouched = () => {
        expect(existsSync(ghCalls)).toBe(false);
        const gitCalls = readFileSync(gitGuard.calls, "utf8");
        expect(gitCalls).toContain("--version");
        expect(gitCalls).not.toContain("update-ref --no-deref refs/openclaw/pr-operation-locks/");
        expect(readFileSync(evidence, "utf8")).toBe("previous exact-head proof\n");
        expect(readdirSync(evidenceRoot)).toEqual(originalArtifacts);
        expect(git("for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks")).toBe(
          "",
        );
      };
      for (const args of [
        ["prepare-push", "123", "--resume-crabbox-run"],
        ["prepare-push", "123", "--resume-crabbox-run", "0"],
        ["prepare-push", "123", "--resume-crabbox-run", "01"],
        ["prepare-push", "123", "--resume-crabbox-run", "9007199254740992"],
        ["prepare-push", "123", "--resume-crabbox-run", "99", "extra"],
        ["prepare-push", "123", "--run-id", "run_fake"],
        ["ci-dispatch", "123", "--backend", "crabbox", "--pending-gates"],
        ["ci-dispatch", "123", "--ci-shape"],
        ["ci-dispatch", "123", "--ci-shape", ""],
        ["ci-dispatch", "123", "--ci-shape", "release"],
        ["ci-dispatch", "123", "--ci-shape", "main", "--ci-shape", "main"],
        ["ci-dispatch", "123", "--test-runtime-policy"],
        ["ci-dispatch", "123", "--test-runtime-policy", ""],
        ["ci-dispatch", "123", "--test-runtime-policy", "dual"],
        [
          "ci-dispatch",
          "123",
          "--test-runtime-policy",
          "node",
          "--test-runtime-policy",
          "dual-all",
        ],
        ["ci-dispatch", "123", "--ci-shape=main"],
        ["ci-dispatch", "123", "--unknown", "main"],
        ["ci-dispatch", "123", "--backend", "crabbox", "--ci-shape", "main"],
        ["ci-dispatch", "123", "--test-runtime-policy", "dual-all", "--backend", "crabbox"],
        ["ci-dispatch", "123", "--backend", "crabbox", "--backend", "crabbox"],
      ]) {
        const result = spawnSync(join(root, "scripts/pr"), args, {
          cwd: root,
          encoding: "utf8",
          env: { ...gitGuard.env, PR_TEST_GH_CALLS: ghCalls },
        });
        expect(result.status, result.stdout + result.stderr).toBe(2);
        expectUntouched();
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
              ...gitGuard.env,
              OPENCLAW_PR_GATES_REMOTE: scenario.mode,
              OPENCLAW_TESTBOX: scenario.hosted,
              PR_TEST_GH_CALLS: ghCalls,
            },
          });
          expect(result.status, result.stdout + result.stderr).toBe(scenario.status);
          expect(result.stderr).toContain(scenario.diagnostic);
          expectUntouched();
        }
      }
      const dispatched = join(root, "dispatched");
      const runUrl = "https://github.com/openclaw/openclaw/actions/runs/99";
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$PR_TEST_GH_CALLS"
case "$1 $2" in
  "auth token") printf 'fixture-token\\n' ;;
  "browse ") printf 'https://github.com/fixture/repo\\n' ;;
  "api --hostname")
    printf '%s\\n' '${JSON.stringify({
      base: { sha: "b".repeat(40), repo: { id: 1 } },
      head: { sha: head, ref: "fixture/coverage", repo: { id: 1 } },
    })}' ;;
  "api repos/openclaw/openclaw/pulls/123") printf '%s\\n' '${head}' ;;
  "workflow run") printf '%s\\0' "$@" >> "$PR_TEST_DISPATCHED" ;;
  "api --method")
    test "$4" = repos/openclaw/openclaw/actions/workflows/ci.yml/runs || exit 97
    if [ -e "$PR_TEST_DISPATCHED" ]; then
      printf '%s\\n' '${JSON.stringify({
        workflow_runs: [
          { id: 99, head_branch: "fixture/coverage", head_sha: head, html_url: runUrl },
        ],
      })}'
    else
      printf '{"workflow_runs":[]}\\n'
    fi ;;
  *) exit 98 ;;
esac
`,
      );
      // Exercise both parsers and the locked public handoff, not just admission:
      // dropped selectors would otherwise silently dispatch default coverage.
      const accepted = spawnSync(
        join(root, "scripts/pr"),
        ["ci-dispatch", "123", "--test-runtime-policy", "dual-all", "--ci-shape", "main"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...gitGuard.env,
            OPENCLAW_GH_BIN: join(bin, "gh"),
            PR_TEST_GH_CALLS: ghCalls,
            PR_TEST_DISPATCHED: dispatched,
          },
        },
      );
      expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain(`observed_run_url=${runUrl}`);
      const calls = readFileSync(ghCalls, "utf8").trim().split("\n");
      const dispatchArgs = readFileSync(dispatched, "utf8").split("\0");
      expect(dispatchArgs.pop()).toBe("");
      expect(dispatchArgs).toEqual([
        "workflow",
        "run",
        "ci.yml",
        "--ref",
        "fixture/coverage",
        "-f",
        `target_ref=${head}`,
        "-f",
        "release_gate=true",
        "-f",
        "pull_request_number=123",
        "-f",
        "runner_backend=hybrid",
        "-f",
        "ci_shape=main",
        "-f",
        "test_runtime_policy=dual-all",
      ]);
      expect(readFileSync(gitGuard.calls, "utf8")).toContain(
        "update-ref --no-deref refs/openclaw/pr-operation-locks/123 ",
      );
      expect(
        calls.filter((line) => line === "api repos/openclaw/openclaw/pulls/123 --jq .head.sha"),
      ).toHaveLength(2);
      expect(readFileSync(evidence, "utf8")).toBe("previous exact-head proof\n");
      expect(readdirSync(evidenceRoot)).toEqual(originalArtifacts);
      expect(git("for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks")).toBe(
        "",
      );
    },
  );
});
