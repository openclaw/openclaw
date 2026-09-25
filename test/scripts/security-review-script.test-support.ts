import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

export const head = "a".repeat(40);
export const landed = "c".repeat(40);
export const pullPath = "/repos/openclaw/openclaw/pulls/7";
export const actions = "/repos/openclaw/openclaw/actions";
export const pr = {
  number: 7,
  state: "open",
  draft: false,
  created_at: "2026-01-01T00:00:00Z",
  user: { id: 1, login: "maintainer", type: "User" },
  changed_files: 2,
  head: { sha: head, ref: "change", repo: { id: 2 } },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
};
export const rollout = {
  number: 152415,
  state: "closed",
  merged: true,
  merged_at: "2025-12-01T00:00:00Z",
  merge_commit_sha: landed,
  base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
};
export const run = {
  id: 10,
  run_attempt: 1,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  head_sha: head,
  head_branch: "change",
  repository: { id: 1 },
  status: "completed",
};
export const jobs = {
  total_count: 1,
  jobs: [{ name: "openclaw/ci-gate", status: "completed", conclusion: "success" }],
};
export const rolePath = "GET /repos/openclaw/openclaw/collaborators/maintainer/permission";
export const statusPath = `POST /repos/openclaw/openclaw/statuses/${head}`;
export const runsPath = `GET ${actions}/workflows/ci.yml/runs`;
export const jobsPath = `GET ${actions}/runs/10/attempts/1/jobs`;
export const files = [
  { filename: "src/gateway/auth.ts", status: "modified" },
  { filename: "pnpm-workspace.yaml", status: "modified" },
];

export const historyPath = `GET /repos/openclaw/openclaw/commits/${head}/statuses`;
export const otherReview = {
  context: "openclaw/ci-gate",
  description: "PR #8: Security review has not completed",
  creator: { login: "github-actions[bot]", type: "Bot" },
};

export function createSecurityReviewFixture(
  tempDirs: Pick<ReturnType<typeof useAutoCleanupTempDirTracker>, "make">,
) {
  function evaluate(routes: Record<string, unknown> = {}, mode = "enforce", deadline?: number) {
    const root = tempDirs.make("security-review-");
    const logPath = path.join(root, "requests.jsonl");
    const fixturePath = path.join(root, "fixture.json");
    const eventPath = path.join(root, "event.json");
    const environmentPath = path.join(root, "environment");
    writeFileSync(environmentPath, "");
    writeFileSync(logPath, "");
    // The resolver selects the PR for CI-completion events as well as PR/comments.
    writeFileSync(eventPath, JSON.stringify({ workflow_run: { id: 10 } }));
    writeFileSync(
      fixturePath,
      JSON.stringify({
        logPath,
        clock: true,
        routes: {
          [`GET ${pullPath}`]: pr,
          [`GET /repos/openclaw/openclaw/commits/${head}/statuses`]: [],
          [`GET ${pullPath}/files`]: files,
          "GET /repos/openclaw/openclaw/pulls/152415": rollout,
          "GET /repos/openclaw/openclaw/issues/7/comments": [],
          "GET /repos/openclaw/openclaw/issues/7/labels": [],
          [rolePath]: { role_name: "maintain" },
          [runsPath]: { total_count: 1, workflow_runs: [run] },
          [jobsPath]: jobs,
          [`GET ${actions}/runs/10`]: run,
          ...routes,
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("test/fixtures/github-guard-fetch.mjs"),
        path.resolve("scripts/github/security-review.mjs"),
      ],
      {
        encoding: "utf8",
        env: {
          GITHUB_TOKEN: "fixture-token",
          OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN: "fixture-autoscrub-token",
          ...(deadline === undefined
            ? {}
            : { OPENCLAW_SECURITY_REVIEW_DEADLINE_MS: String(deadline) }),
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_ENV: environmentPath,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "123",
          OPENCLAW_SECURITY_REVIEW_PR_NUMBER: "7",
          OPENCLAW_SECURITY_REVIEW_HEAD_SHA: head,
          OPENCLAW_SECURITY_REVIEW_MODE: mode,
          OPENCLAW_GUARD_TEST_FIXTURE: fixturePath,
        },
      },
    );
    const requests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            delay?: number;
            path: string;
            body?: { context?: string; state?: string; body?: string };
          },
      );
    return {
      ...result,
      environment: readFileSync(environmentPath, "utf8"),
      requests,
      waits: requests.filter((entry) => entry.method === "WAIT").map((entry) => entry.delay!),
      combined: requests
        .filter((entry) => entry.body?.context === "openclaw/ci-gate")
        .map((entry) => entry.body?.state),
      reviews: requests.filter((entry) => entry.body?.context?.endsWith("-review")),
    };
  }

  return evaluate;
}
