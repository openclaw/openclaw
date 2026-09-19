import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const landed = "c".repeat(40);
const pullPath = "/repos/openclaw/openclaw/pulls/7";
const actions = "/repos/openclaw/openclaw/actions";
const pr = {
  number: 7,
  state: "open",
  draft: false,
  created_at: "2026-01-01T00:00:00Z",
  user: { id: 1, login: "maintainer", type: "User" },
  changed_files: 2,
  head: { sha: head, ref: "change", repo: { id: 2 } },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
};
const rollout = {
  number: 152415,
  state: "closed",
  merged: true,
  merged_at: "2025-12-01T00:00:00Z",
  merge_commit_sha: landed,
  base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
};
const run = {
  id: 10,
  run_attempt: 1,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  head_sha: head,
  head_branch: "change",
  repository: { id: 1 },
  status: "completed",
};
const jobs = {
  total_count: 1,
  jobs: [{ name: "openclaw/ci-gate", status: "completed", conclusion: "success" }],
};
const rolePath = "GET /repos/openclaw/openclaw/collaborators/maintainer/permission";
const runsPath = `GET ${actions}/workflows/ci.yml/runs`;
const jobsPath = `GET ${actions}/runs/10/attempts/1/jobs`;

const historyPath = `GET /repos/openclaw/openclaw/commits/${head}/statuses`;
const otherReview = {
  context: "openclaw/ci-gate",
  description: "PR #8: Security review has not completed",
  creator: { login: "github-actions[bot]", type: "Bot" },
};

function evaluate(routes: Record<string, unknown> = {}, mode = "enforce") {
  const root = tempDirs.make("security-review-");
  const logPath = path.join(root, "requests.jsonl");
  const fixturePath = path.join(root, "fixture.json");
  const eventPath = path.join(root, "event.json");
  writeFileSync(logPath, "");
  // The resolver selects the PR for CI-completion events as well as PR/comments.
  writeFileSync(eventPath, JSON.stringify({ workflow_run: { id: 10 } }));
  writeFileSync(
    fixturePath,
    JSON.stringify({
      logPath,
      routes: {
        [`GET ${pullPath}`]: pr,
        [`GET /repos/openclaw/openclaw/commits/${head}/statuses`]: [],
        [`GET ${pullPath}/files`]: [
          { filename: "src/gateway/auth.ts", status: "modified" },
          { filename: "pnpm-workspace.yaml", status: "modified" },
        ],
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
        GITHUB_EVENT_PATH: eventPath,
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
          path: string;
          body?: { context?: string; state?: string; body?: string };
        },
    );
  return {
    ...result,
    requests,
    combined: requests
      .filter((entry) => entry.body?.context === "openclaw/ci-gate")
      .map((entry) => entry.body?.state),
    reviews: requests.filter((entry) => entry.body?.context?.endsWith("-review")),
  };
}

describe("combined security review entry point", () => {
  it("requires successful CI and both guard decisions on the actual PR head", () => {
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["failure", "success"]);
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
    expect(
      result.requests
        .filter((entry) => entry.path.includes("/statuses/"))
        .every((entry) => entry.path.endsWith(head) && entry.body?.state !== "pending"),
    ).toBe(true);
  });

  it("does not transfer an author's exemption to another PR with the same head", () => {
    const result = evaluate({
      [historyPath]: [otherReview],
      "GET /repos/openclaw/openclaw/pulls/8": {
        ...pr,
        number: 8,
        user: { id: 2, login: "contributor", type: "User" },
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("same head");
    expect(result.combined).not.toContain("success");
    expect(result.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it("rechecks recorded PR identities before the combined success", () => {
    const result = evaluate({
      [historyPath]: { responses: [[], [], [otherReview]] },
      "GET /repos/openclaw/openclaw/pulls/8": { ...pr, number: 8 },
    });
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
  });

  it("fails closed when recorded PR identity cannot be read", () => {
    const result = evaluate({ [historyPath]: { httpError: 403 } });
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
  });

  it.each([
    { ...otherReview, creator: { login: "contributor", type: "User" } },
    { ...otherReview, context: "unrelated-check" },
    { ...otherReview, description: "unstructured legacy result" },
  ])("ignores untrusted or unrelated status records (%j)", (record) => {
    const result = evaluate({ [historyPath]: [record] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.some((entry) => entry.path.endsWith("/pulls/8"))).toBe(false);
  });

  it.each([
    { ...pr, number: 8, state: "closed" },
    { ...pr, number: 8, head: { ...pr.head, sha: "d".repeat(40) } },
  ])("recovers after another recorded PR stops sharing the head (%j)", (other) => {
    const result = evaluate({
      [historyPath]: [otherReview],
      "GET /repos/openclaw/openclaw/pulls/8": other,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["failure", "success"]);
  });

  it.each(["openclaw/ci-gate", "openclaw/dependency-review", "openclaw/security-sensitive-review"])(
    "leaves %s failed before GitHub can exhaust its status-write capacity",
    (context) => {
      const result = evaluate({
        [historyPath]: Array.from({ length: 900 }, () => ({
          ...otherReview,
          context,
          description: "PR #7: Previous review",
          state: "success",
        })),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("capacity is nearly exhausted");
      expect(result.combined).not.toContain("success");
      expect(
        result.requests.findLast((entry) => entry.body?.context === context)?.body?.state,
      ).toBe("failure");
    },
  );

  it("cannot publish under another head's concurrency slot after scheduling", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("head changed after scheduling");
    expect(result.requests.some((entry) => entry.method !== "GET")).toBe(false);
  });

  it("accepts the existing exact-head CI fallback without a manual guard run", () => {
    const fallback = {
      ...run,
      event: "workflow_dispatch",
      display_title: `CI release gate ${head}`,
    };
    const result = evaluate({
      [runsPath]: { total_count: 1, workflow_runs: [fallback] },
      [`GET ${actions}/runs/10`]: fallback,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["failure", "success"]);
  });

  it("does not accept a manual historical-target run as current PR proof", () => {
    const result = evaluate({
      [runsPath]: {
        total_count: 1,
        workflow_runs: [{ ...run, event: "workflow_dispatch", display_title: "CI" }],
      },
    });
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
  });

  it("finds the CI gate beyond the first page of a large CI run", () => {
    const result = evaluate({
      [jobsPath]: {
        responses: [
          {
            total_count: 101,
            jobs: Array.from({ length: 100 }, () => ({
              name: "test shard",
              status: "completed",
              conclusion: "success",
            })),
          },
          { ...jobs, total_count: 101 },
        ],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["failure", "success"]);
    expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(2);
  });

  it.each([
    { name: "missing CI", response: { total_count: 0, workflow_runs: [] } },
    {
      name: "unfinished CI",
      response: { total_count: 1, workflow_runs: [{ ...run, status: "in_progress" }] },
    },
    {
      name: "another workflow",
      response: {
        total_count: 1,
        workflow_runs: [{ ...run, path: ".github/workflows/forged.yml" }],
      },
    },
    {
      name: "stale head",
      response: { total_count: 1, workflow_runs: [{ ...run, head_sha: "d".repeat(40) }] },
    },
    {
      name: "newer unfinished run",
      response: { total_count: 2, workflow_runs: [run, { ...run, id: 11, status: "queued" }] },
    },
  ])("does not turn $name into a passing combined gate", ({ response }) => {
    const result = evaluate({ [runsPath]: response });
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
  });

  it.each(["failure", "cancelled", "skipped", "neutral"])(
    "does not hide a %s CI gate",
    (conclusion) => {
      const result = evaluate({ [jobsPath]: { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion }] } });
      expect(result.status).toBe(1);
      expect(result.combined).not.toContain("success");
    },
  );

  it("does not accept a previously successful CI attempt while a new attempt runs", () => {
    const result = evaluate({
      [`GET ${actions}/runs/10`]: { ...run, run_attempt: 2, status: "in_progress" },
    });
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
  });

  it("publishes both review notices even when both approvals are missing", () => {
    const result = evaluate({ [rolePath]: { role_name: "write" } });
    expect(result.status).toBe(1);
    expect(result.combined).toEqual(["failure"]);
    const notices = result.requests.filter(
      (entry) => entry.method === "POST" && entry.path.endsWith("/comments"),
    );
    expect(notices).toHaveLength(2);
    expect(notices.map((entry) => entry.body?.body).join("\n")).toContain(
      "/allow-dependencies-change",
    );
    expect(notices.map((entry) => entry.body?.body).join("\n")).toContain(
      "/allow-security-sensitive-change",
    );
  });

  it("rechecks author authority after CI reads before publishing success", () => {
    const result = evaluate({
      [rolePath]: {
        responses: [
          { role_name: "maintain" },
          { role_name: "maintain" },
          { role_name: "maintain" },
          { role_name: "read" },
        ],
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("approval changed");
    expect(result.combined).not.toContain("success");
  });

  it("keeps an unchanged PR approved when main advances during evaluation", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: {
        responses: [pr, { ...pr, base: { ...pr.base, sha: "e".repeat(40) } }],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["failure", "success"]);
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
  });

  it.each([
    { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
    { ...pr, base: { ...pr.base, ref: "stable" } },
  ])("does not publish success for a PR that changes during evaluation: %j", (changedPr) => {
    const result = evaluate({
      [`GET ${pullPath}`]: {
        responses: [pr, pr, pr, pr, pr, changedPr],
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pull request changed");
    expect(result.combined).not.toContain("success");
  });

  const exemptRoutes = {
    "GET /repos/openclaw/openclaw/pulls/152415": { ...rollout, merged_at: "2026-02-01T00:00:00Z" },
    [`GET /repos/openclaw/openclaw/compare/${landed}...${head}`]: {
      base_commit: { sha: landed },
      merge_base_commit: { sha: "b".repeat(40) },
      status: "diverged",
    },
  };

  it("grandfathers an old branch without issuing reusable standalone successes or notices", () => {
    const result = evaluate(exemptRoutes);
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["failure", "success"]);
    expect(result.reviews).toEqual([]);
    expect(result.requests.some((entry) => entry.path.includes("/issues/"))).toBe(false);
    expect(result.requests.some((entry) => entry.path.endsWith("/files"))).toBe(false);
  });

  it("still requires real CI for a grandfathered PR", () => {
    const result = evaluate({ ...exemptRoutes, [runsPath]: { total_count: 0, workflow_runs: [] } });
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
    expect(result.reviews).toEqual([]);
  });

  it("does not autoscrub a grandfathered PR", () => {
    const result = evaluate(exemptRoutes, "autoscrub");
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.requests
        .filter((entry) => entry.method !== "GET")
        .every((entry) => entry.body?.context === "openclaw/ci-gate"),
    ).toBe(true);
  });

  it("activates both guards once an old head contains the rollout commit", () => {
    const result = evaluate({
      ...exemptRoutes,
      [`GET /repos/openclaw/openclaw/compare/${landed}...${head}`]: {
        base_commit: { sha: landed },
        merge_base_commit: { sha: landed },
        status: "ahead",
      },
      [rolePath]: { role_name: "read" },
    });
    expect(result.status).toBe(1);
    expect(result.reviews.filter((entry) => entry.body?.state === "failure")).toHaveLength(4);
    expect(result.combined).not.toContain("success");
  });

  it("leaves the combined gate failed when rollout metadata cannot be read", () => {
    const result = evaluate({ "GET /repos/openclaw/openclaw/pulls/152415": { httpError: 403 } });
    expect(result.status).toBe(1);
    expect(result.combined).toEqual(["failure"]);
    expect(result.reviews).toEqual([]);
  });
});
