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
  maintainer_can_modify: true,
  created_at: "2026-01-01T00:00:00Z",
  user: { id: 1, login: "maintainer", type: "User" },
  changed_files: 2,
  head: { sha: head, ref: "change", repo: { id: 2 } },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
};
const lifecycleChanges = [
  { name: "closed PR", changedPr: { ...pr, state: "closed" } },
  {
    name: "closed PR with maintainer edits disabled",
    changedPr: { ...pr, state: "closed", maintainer_can_modify: false },
  },
  { name: "draft PR", changedPr: { ...pr, draft: true } },
  { name: "target branch", changedPr: { ...pr, base: { ...pr.base, ref: "stable" } } },
];
const mergedPr = { ...pr, state: "closed", merged: true, maintainer_can_modify: false };
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
const statusPath = `POST /repos/openclaw/openclaw/statuses/${head}`;
const runsPath = `GET ${actions}/workflows/ci.yml/runs`;
const jobsPath = `GET ${actions}/runs/10/attempts/1/jobs`;
const files = [
  { filename: "src/gateway/auth.ts", status: "modified" },
  { filename: "pnpm-workspace.yaml", status: "modified" },
];

const historyPath = `GET /repos/openclaw/openclaw/commits/${head}/statuses`;
const otherReview = {
  context: "openclaw/ci-gate",
  description: "PR #8: Security review has not completed",
  creator: { login: "github-actions[bot]", type: "Bot" },
};

const lockfilePr = {
  ...pr,
  changed_files: 1,
  head: { ...pr.head, repo: { id: 1, full_name: "openclaw/openclaw" } },
};
const lockfileContents = {
  type: "file",
  encoding: "base64",
  content: Buffer.from("lockfileVersion: '9.0'\n").toString("base64"),
};
const lockfileRoutes = {
  [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml", status: "modified" }],
  [rolePath]: { role_name: "read" },
  [`GET /repos/openclaw/openclaw/dependency-graph/compare/${pr.base.sha}...${head}`]: [],
  [`GET /repos/openclaw/openclaw/compare/${pr.base.sha}...${head}`]: {
    base_commit: { sha: pr.base.sha },
    merge_base_commit: { sha: pr.base.sha },
  },
};

function evaluate(
  routes: Record<string, unknown> = {},
  mode = "enforce",
  deadline?: number,
  completedCi?: { id: number; attempt: number },
) {
  const root = tempDirs.make("security-review-");
  const logPath = path.join(root, "requests.jsonl");
  const fixturePath = path.join(root, "fixture.json");
  const eventPath = path.join(root, "event.json");
  const environmentPath = path.join(root, "environment");
  const outputPath = path.join(root, "output");
  writeFileSync(outputPath, "");
  writeFileSync(environmentPath, "");
  writeFileSync(logPath, "");
  // The resolver selects the PR for CI-completion events as well as PR/comments.
  writeFileSync(
    eventPath,
    JSON.stringify({ repository: { default_branch: "main" }, workflow_run: { id: 10 } }),
  );
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
        ...(completedCi
          ? {
              OPENCLAW_SECURITY_REVIEW_CI_RUN_ID: String(completedCi.id),
              OPENCLAW_SECURITY_REVIEW_CI_RUN_ATTEMPT: String(completedCi.attempt),
            }
          : {}),
        GITHUB_ENV: environmentPath,
        GITHUB_OUTPUT: outputPath,
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
    output: readFileSync(outputPath, "utf8"),
    requests,
    waits: requests.filter((entry) => entry.method === "WAIT").map((entry) => entry.delay!),
    combined: requests
      .filter((entry) => entry.body?.context === "openclaw/ci-gate")
      .map((entry) => entry.body?.state),
    reviews: requests.filter((entry) => entry.body?.context?.endsWith("-review")),
  };
}

type ReviewResult = ReturnType<typeof evaluate>;

function expectReview(
  result: ReviewResult,
  gate: string | string[] | false,
  status = 0,
  waits?: number[],
) {
  expect(result.status, result.stderr).toBe(status);
  if (gate === false) {
    expect(result.combined).not.toContain("success");
  } else if (Array.isArray(gate)) {
    expect(result.combined).toEqual(gate);
  } else {
    expect(result.combined.at(-1)).toBe(gate);
  }
  if (waits) {
    expect(result.waits).toEqual(waits);
  }
}

function changedAfter<T>(reads: number, next: T, initial = pr) {
  return { responses: [...Array.from({ length: reads }, () => initial), next] };
}

function settles<T, U>(before: T, after: U, seconds = 30) {
  return { settlesAt: `2026-01-02T00:00:${String(seconds).padStart(2, "0")}Z`, before, after };
}

function requestsFor(result: ReviewResult, route: string) {
  return result.requests.filter((entry) => `${entry.method} ${entry.path}` === route);
}

function afterFirstWait(result: ReviewResult) {
  return result.requests.slice(result.requests.findIndex((entry) => entry.method === "WAIT") + 1);
}

const filePage = () =>
  Array.from({ length: 100 }, (_, index) => ({
    filename: `docs/page-${index}.md`,
    status: "modified",
  }));

describe("combined security review entry point", () => {
  it("finishes ordinary preparation with the same decisions and fewer requests than separate detection", () => {
    const detection = evaluate({}, "detect");
    const enforcement = evaluate();
    const prepared = evaluate({}, "prepare");
    expectReview(prepared, ["pending", "success"]);
    expect(prepared.output).toContain("autoscrub=false\n");
    expect(prepared.output).toContain("completed=true\n");
    expect(prepared.requests).toEqual(enforcement.requests);
    expect(prepared.reviews).toEqual(enforcement.reviews);
    expect(detection.requests.length).toBeGreaterThan(0);
    expect(prepared.requests.length).toBeLessThan(
      detection.requests.length + enforcement.requests.length,
    );
  });

  it("leaves cleanup candidates pending for autoscrub and fresh enforcement", () => {
    const routes = { ...lockfileRoutes, [`GET ${pullPath}`]: lockfilePr };
    const prepared = evaluate(routes, "prepare");
    expectReview(prepared, ["pending"]);
    expect(prepared.output).toContain("autoscrub=true\n");
    expect(prepared.output).not.toContain("completed=true");
    expect(prepared.requests.some((entry) => entry.path === "/graphql")).toBe(false);
    const enforcement = evaluate(routes);
    expect(enforcement.requests[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(enforcement.combined.at(-1)).toBe("failure");
  });

  it.each([
    { name: "real error", response: { httpError: 401 }, status: 1 },
    { name: "ineligible PR", response: { ...pr, draft: true }, status: 0 },
  ])("does not complete preparation after $name", ({ response, status }) => {
    const result = evaluate({ [`GET ${pullPath}`]: response }, "prepare");
    expect(result.status, result.stderr).toBe(status);
    expect(result.output).not.toContain("completed=true");
    expect(result.combined).not.toContain("success");
  });

  it("shares notice inventories between both guards without sharing approval authority", () => {
    const result = evaluate();
    expectReview(result, "success");
    for (const inventory of ["comments", "labels"]) {
      expect(
        result.requests.filter(
          (entry) =>
            entry.method === "GET" &&
            entry.path === `/repos/openclaw/openclaw/issues/7/${inventory}`,
        ),
      ).toHaveLength(1);
    }
    expect(
      result.requests.filter((entry) => entry.method === "GET" && entry.path === rolePath.slice(4))
        .length,
    ).toBeGreaterThan(1);
  });

  it.each([
    {
      name: "fetch deadline",
      route: `GET ${pullPath}`,
      response: pr,
      failure: { requestTimeout: "fetch" },
    },
    {
      name: "body deadline",
      route: rolePath,
      response: { role_name: "maintain" },
      failure: { requestTimeout: "body" },
    },
    ...[{ httpError: 500 }, { transportError: "ECONNRESET" }].map((failure) => ({
      name: JSON.stringify(failure),
      route: statusPath,
      response: {},
      failure,
    })),
  ])("restarts evaluation after $name", ({ route, response, failure }) => {
    const result = evaluate({ [route]: { responses: [failure, response] } });
    expectReview(result, "success", 0, [1_000]);
    const afterWait = afterFirstWait(result);
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
  });

  it("rereads author authority after a read deadline instead of retaining approval", () => {
    const result = evaluate({
      [jobsPath]: { responses: [{ requestTimeout: "fetch" }, jobs] },
      [rolePath]: settles({ role_name: "maintain" }, { role_name: "read" }),
    });
    expectReview(result, "failure", 0, [1_000]);
    const afterWait = afterFirstWait(result);
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(afterWait.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it("recovers a lockfile read deadline before submitting one cleanup commit", () => {
    const result = evaluate(
      {
        ...lockfileRoutes,
        [`GET ${pullPath}`]: lockfilePr,
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=${pr.base.sha}`]: {
          responses: [{ requestTimeout: "fetch" }, lockfileContents],
        },
        "POST /graphql": { data: { createCommitOnBranch: { commit: { oid: "e".repeat(40) } } } },
      },
      "autoscrub",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    const afterWait = afterFirstWait(result);
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(result.requests.filter((entry) => entry.path === "/graphql")).toHaveLength(1);
  });

  const permissionDenied = { httpError: 403, message: "Resource not accessible by integration" };
  const forbiddenMutation = { type: "FORBIDDEN", path: ["createCommitOnBranch"] };
  const committed = { createCommitOnBranch: { commit: { oid: "e".repeat(40) } } };
  function cleanupCase<T>(name: string, response: T, unavailable = false, baseReadDenied = false) {
    return { name, response, unavailable, baseReadDenied };
  }
  it.each([
    cleanupCase("HTTP permission denial", permissionDenied, true),
    cleanupCase(
      "GraphQL permission denial",
      {
        errors: [{ ...forbiddenMutation, message: "Resource not accessible by integration" }],
      },
      true,
    ),
    cleanupCase("unknown HTTP 403", { httpError: 403 }),
    cleanupCase("stale head", {
      errors: [{ type: "STALE_DATA", message: "Expected branch head to match" }],
    }),
    cleanupCase("mixed GraphQL errors", { errors: [forbiddenMutation, { type: "INTERNAL" }] }),
    cleanupCase("commit response field denial", {
      errors: [{ type: "FORBIDDEN", path: ["createCommitOnBranch", "commit", "oid"] }],
    }),
    cleanupCase("partial commit response", { data: committed, errors: [forbiddenMutation] }),
    cleanupCase("base read permission denial", permissionDenied, false, true),
  ])(
    "keeps cleanup $name separate from dependency approval",
    ({ response, unavailable, baseReadDenied }) => {
      const routes = {
        ...lockfileRoutes,
        [`GET ${pullPath}`]: {
          ...lockfilePr,
          maintainer_can_modify: true,
          head: { ...pr.head, repo: { id: 2, full_name: "contributor/openclaw" } },
        },
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml`]: baseReadDenied
          ? response
          : lockfileContents,
        "POST /graphql": response,
      };
      const cleanup = evaluate(routes, "autoscrub");
      expect(cleanup.status, cleanup.stderr).toBe(unavailable ? 0 : 1);
      expect(cleanup.requests.filter((entry) => entry.path === "/graphql")).toHaveLength(
        baseReadDenied ? 0 : 1,
      );
      expect(cleanup.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
      expect(cleanup.waits).toEqual([]);
      if (unavailable) {
        const notice = cleanup.requests.find(
          (entry) => entry.method === "POST" && entry.path.endsWith("/comments"),
        );
        expect(notice?.body?.body).toContain("Automatic lockfile cleanup is best effort.");
        const enforcement = evaluate(routes);
        expectReview(enforcement, "failure");
        expect(
          enforcement.reviews.findLast(
            (entry) => entry.body?.context === "openclaw/dependency-review",
          )?.body?.state,
        ).toBe("failure");
        expect(enforcement.stdout).toContain("Automatic lockfile cleanup is best effort.");
      } else {
        expect(cleanup.combined.at(-1)).toBe("failure");
        expect(cleanup.stderr).toContain("autoscrub failed");
      }
    },
  );

  it.each([
    { name: "cleanup mutation", response: { httpError: 500 }, noticeFailure: false },
    {
      name: "cleanup notice",
      response: { data: { createCommitOnBranch: { commit: { oid: "e".repeat(40) } } } },
      noticeFailure: true,
    },
  ])("preserves a failed $name when the PR then closes", ({ response, noticeFailure }) => {
    const result = evaluate(
      {
        ...lockfileRoutes,
        [`GET ${pullPath}`]: changedAfter(4, { ...lockfilePr, state: "closed" }, lockfilePr),
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml`]: lockfileContents,
        "POST /graphql": response,
        ...(noticeFailure
          ? { "POST /repos/openclaw/openclaw/issues/7/comments": { httpError: 500 } }
          : {}),
      },
      "autoscrub",
    );
    expectReview(result, false, 1, []);
    expect(result.stderr).toContain("Dependency lockfile autoscrub failed");
    expect(result.stderr).toContain("Fixture API failure");
    expect(result.requests.filter((entry) => entry.path === "/graphql")).toHaveLength(1);
  });

  it("does not replay a rejected notice write when a sibling read later times out", () => {
    const commentPath = "/repos/openclaw/openclaw/issues/7/comments";
    const result = evaluate({
      [`POST ${commentPath}`]: { httpError: 400 },
      [rolePath]: {
        responses: [
          { role_name: "maintain" },
          { role_name: "maintain" },
          { requestTimeout: "fetch" },
        ],
      },
    });
    expectReview(result, "failure", 1, []);
    expect(requestsFor(result, `POST ${commentPath}`)).toHaveLength(1);
    expect(result.stderr).toContain(`GitHub API POST ${commentPath} failed: 400`);
  });

  it.each([
    { name: "status", route: statusPath },
    { name: "comment", route: "POST /repos/openclaw/openclaw/issues/7/comments" },
  ])("does not restart evaluation after an uncertain $name write deadline", ({ route }) => {
    const result = evaluate({
      [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
      [`GET ${pullPath}/files`]: [files[1]],
      [route]: { requestTimeout: "body" },
    });
    expectReview(result, false, 1, []);
    expect(requestsFor(result, route)).toHaveLength(1);
    expect(result.stderr).toContain("exceeded timeout 30000ms");
  });

  it.each([
    { phase: "before dependency approval", stableReads: 2 },
    { phase: "between guards", stableReads: 3 },
    { phase: "before combined success", stableReads: 5 },
  ])("restarts the complete review when the file count changes $phase", ({ stableReads }) => {
    const changed = { ...pr, changed_files: 3 };
    const result = evaluate({
      [`GET ${pullPath}`]: changedAfter(stableReads, changed),
      [`GET ${pullPath}/files`]: {
        responses: [files, [...files, { filename: "src/secrets/store.ts", status: "modified" }]],
      },
      [rolePath]: settles({ role_name: "maintain" }, { role_name: "read" }),
    });
    expectReview(result, "failure", 0, [30_000, 30_000]);
    const afterWait = afterFirstWait(result);
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(afterWait.some((entry) => entry.body?.state === "success")).toBe(false);
    expect(afterWait.map((entry) => entry.body?.body ?? "").join("\n")).toContain(
      "src/secrets/store.ts",
    );
  });

  it("restarts incomplete pagination and still requires approval for recovered sensitive files", () => {
    const firstPage = filePage();
    const result = evaluate({
      [`GET ${pullPath}`]: { ...pr, changed_files: 102 },
      [`GET ${pullPath}/files`]: { responses: [firstPage, [], firstPage, files] },
      [rolePath]: { role_name: "read" },
    });
    expectReview(result, "failure", 0, [30_000, 30_000]);
    expect(result.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
    const notices = result.requests.map((entry) => entry.body?.body ?? "").join("\n");
    expect(notices).toContain("/allow-dependencies-change");
    expect(notices).toContain("/allow-security-sensitive-change");
  });

  it.each([
    { name: "head", changedPr: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } }, status: 0 },
    ...lifecycleChanges.map(({ name, changedPr }) => ({ name, changedPr, status: 0 })),
    {
      name: "author",
      changedPr: { ...pr, user: { id: 2, login: "other-author", type: "User" } },
      status: 1,
    },
  ])("stops for a changed $name during file-list recovery", ({ changedPr, status }) => {
    const result = evaluate({
      [`GET ${pullPath}`]: changedAfter(2, changedPr),
      [`GET ${pullPath}/files`]: { responses: [files.slice(0, 1), files] },
    });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toContain(
      status === 0 ? "skipping" : "pull request changed",
    );
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it.each([false, true])(
    "checks the head before more slow file pages (superseded=%s)",
    (superseded) => {
      const firstPage = filePage();
      const original = { ...pr, changed_files: 202 };
      const result = evaluate({
        [`GET ${pullPath}`]: settles(
          original,
          superseded ? { ...original, head: { ...pr.head, sha: "d".repeat(40) } } : original,
        ),
        [`GET ${pullPath}/files`]: {
          responses: [
            { advanceMs: 15_000, response: firstPage },
            { advanceMs: 15_000, response: firstPage },
            files,
          ],
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.requests.filter((entry) => entry.path === pullPath + "/files")).toHaveLength(
        superseded ? 2 : 3,
      );
      if (superseded) {
        expect(result.stdout).toContain("Superseded");
        expect(result.requests.at(-1)).toEqual({ method: "GET", path: pullPath });
        expect(result.requests.some((entry) => entry.path.endsWith("/comments"))).toBe(false);
        expect(result.combined).not.toContain("success");
      } else {
        expect(result.combined.at(-1)).toBe("success");
      }
    },
  );

  it("keeps checkpoint reads inside the original backoff interval", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: { responses: [pr, pr, { advanceMs: 20_000, response: pr }, pr] },
      [`GET ${pullPath}/files`]: { responses: [files.slice(0, 1), files] },
    });
    expectReview(result, "success", 0, [30_000, 10_000]);
  });

  it("honors a rate limit from a recovery checkpoint before observing supersession", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: {
        responses: [
          pr,
          pr,
          { httpError: 429, headers: { "retry-after": "180" } },
          { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
        ],
      },
      [`GET ${pullPath}/files`]: files.slice(0, 1),
    });
    expectReview(result, false);
    expect(result.stdout).toContain("Superseded");
    expect(result.waits).toHaveLength(2);
    expect(result.waits[0]).toBe(30_000);
    expect(result.waits[1]).toBeGreaterThanOrEqual(180_000);
    const checkpoint = result.requests.findIndex((entry) => entry.method === "WAIT");
    expect(result.requests.slice(checkpoint).map((entry) => entry.method)).toEqual([
      "WAIT",
      "GET",
      "WAIT",
      "GET",
    ]);
  });

  it("fails closed when a recovery checkpoint cannot read the PR", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: { responses: [pr, pr, { httpError: 403 }] },
      [`GET ${pullPath}/files`]: files.slice(0, 1),
    });
    expectReview(result, "failure", 1, [30_000]);
    expect(result.stderr).toContain("Fixture API failure");
  });

  it("bounds file-list recovery across both guards and reports the conflicting counts", () => {
    const result = evaluate({ [`GET ${pullPath}/files`]: files.slice(0, 1) });
    expectReview(result, "failure", 1, Array<number>(14).fill(30_000));
    expect(result.requests.filter((entry) => entry.path === `${pullPath}/files`)).toHaveLength(4);
    expect(result.stderr).toContain("expected 2, received 1, current count 2");
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.stderr).not.toContain("Split the PR");
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it.each([
    {
      httpError: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767315600" },
      minimum: 3_600_000,
    },
    { httpError: 429, headers: { "retry-after": "90" }, minimum: 90_000 },
    {
      httpError: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1767315600",
        "retry-after": "120",
      },
      minimum: 3_600_000,
    },
    { httpError: 403, message: "You have exceeded a secondary rate limit.", minimum: 60_000 },
  ])(
    "recovers a rate-limited PR lookup using server timing: $httpError $minimum",
    ({ minimum, ...limited }) => {
      const result = evaluate({ [`GET ${pullPath}`]: { responses: [limited, pr] } });
      expectReview(result, "success");
      expect(result.waits).toHaveLength(1);
      expect(result.waits[0]).toBeGreaterThanOrEqual(minimum);
      expect(result.waits[0]).toBeLessThan(minimum + 17_000);
      expect(result.environment).toBe(
        `OPENCLAW_SECURITY_REVIEW_DEADLINE_MS=${Date.parse("2026-01-02T01:05:00Z")}\n`,
      );
    },
  );

  it.each([
    { httpError: 429 },
    { httpError: 500, recordStatusBeforeError: true },
    { transportError: "ECONNRESET" },
  ])("rereads authority after a failed success write instead of replaying it: %j", (failure) => {
    const result = evaluate({
      // First POST records pending; the dependency guard then records failure and success.
      [statusPath]: {
        responses: [{}, {}, failure, {}],
      },
      [rolePath]: {
        responses: [{ role_name: "maintain" }, { role_name: "maintain" }, { role_name: "read" }],
      },
    });
    expectReview(result, "failure");
    expect(result.waits).toHaveLength(1);
    const afterWait = afterFirstWait(result);
    expect(afterWait[0]?.path).toBe(pullPath);
    expect(afterWait.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it("stops after the head changes while recovering a failed success write", () => {
    const result = evaluate({
      [statusPath]: { responses: [{}, {}, { httpError: 500 }, {}] },
      [`GET ${pullPath}`]: changedAfter(3, { ...pr, head: { ...pr.head, sha: "d".repeat(40) } }),
    });
    expectReview(result, false, 0, [1_000]);
    expect(result.stdout).toContain("Superseded");
    const afterWait = afterFirstWait(result);
    expect(afterWait.every((entry) => entry.method === "GET")).toBe(true);
  });

  it.each([
    { failure: { httpError: 429, headers: { "retry-after": "120" } }, minimumDelay: 120_000 },
    { failure: { httpError: 500 }, minimumDelay: 1_000 },
  ])(
    "preserves publication recovery when reporting an inconsistent diff: $failure.httpError",
    ({ failure, minimumDelay }) => {
      const result = evaluate({
        [statusPath]: { responses: [{}, {}, failure, {}] },
        [`GET ${pullPath}/files`]: { responses: [files.slice(0, 1), files] },
      });
      expectReview(result, "success");
      expect(result.waits).toHaveLength(1);
      expect(result.waits[0]).toBeGreaterThanOrEqual(minimumDelay);
      expect(result.waits[0]).toBeLessThan(minimumDelay + 17_000);
    },
  );

  it("rereads CI after a failed combined-success publication", () => {
    const result = evaluate({
      [statusPath]: { responses: [{}, {}, {}, {}, {}, { httpError: 500 }, {}] },
      [jobsPath]: {
        responses: [jobs, { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: "failure" }] }],
      },
    });
    expectReview(result, "failure", 0, [1_000]);
    expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(2);
  });

  it("shares three evaluation restarts between status failures and rate limits", () => {
    const result = evaluate({
      [statusPath]: {
        responses: [{ httpError: 500 }, { httpError: 429 }, { httpError: 500 }],
      },
    });
    expectReview(result, false, 1);
    expect(result.waits).toHaveLength(3);
    expect(result.waits[0]).toBe(1_000);
    expect(result.waits[1]).toBeGreaterThanOrEqual(120_000);
    expect(result.waits[1]).toBeLessThan(137_000);
    expect(result.waits[2]).toBe(4_000);
    expect(result.requests.filter((entry) => entry.method === "POST")).toHaveLength(4);
    expect(result.stderr).toContain("recovery budget exhausted");
  });

  it.each([
    { name: "comment only", statusReplies: [{}] },
    { name: "failure report also fails", statusReplies: [{}, {}, {}, {}, {}, { httpError: 500 }] },
    { name: "sibling status also fails", statusReplies: [{}, {}, {}, { httpError: 500 }, {}] },
  ])(
    "does not restart evaluation for a rejected comment publication: $name",
    ({ statusReplies }) => {
      const commentPath = "/repos/openclaw/openclaw/issues/7/comments";
      const result = evaluate({
        [statusPath]: { responses: statusReplies },
        [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
        [`GET ${pullPath}/files`]: [files[1]],
        [`POST ${commentPath}`]: { httpError: 400 },
      });
      expectReview(result, "failure", 1, []);
      expect(requestsFor(result, `POST ${commentPath}`)).toHaveLength(1);
      expect(result.stderr).toContain(`GitHub API POST ${commentPath} failed: 400`);
    },
  );

  it.each([
    { name: "dependency", file: files[1] },
    { name: "security-sensitive", file: files[0] },
  ])("recovers a failed $name notice without creating a duplicate", ({ file }) => {
    const commentPath = "/repos/openclaw/openclaw/issues/7/comments";
    for (const accepted of [false, true]) {
      const result = evaluate({
        [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
        [`GET ${pullPath}/files`]: [file],
        [`POST ${commentPath}`]: {
          responses: [{ httpError: 500, recordCommentBeforeError: accepted }, {}],
        },
      });
      expectReview(result, "success", 0, [1_000]);
      const afterWait = afterFirstWait(result);
      expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
      const commentRead = afterWait.findIndex(
        (entry) => entry.method === "GET" && entry.path === commentPath,
      );
      const commentWrite = afterWait.findIndex((entry) => entry.body?.body);
      expect(commentRead).toBeGreaterThanOrEqual(0);
      expect(commentWrite).toBeGreaterThan(commentRead);
      expect(afterWait[commentWrite]).toMatchObject({
        method: accepted ? "PATCH" : "POST",
        path: accepted ? "/repos/openclaw/openclaw/issues/comments/321" : commentPath,
      });
      expect(requestsFor(result, `POST ${commentPath}`)).toHaveLength(accepted ? 1 : 2);
    }
  });

  it("rereads author authority while recovering an accepted notice write", () => {
    const commentPath = "/repos/openclaw/openclaw/issues/7/comments";
    const result = evaluate({
      [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
      [`GET ${pullPath}/files`]: [files[0]],
      [`POST ${commentPath}`]: { httpError: 500, recordCommentBeforeError: true },
      [rolePath]: settles({ role_name: "maintain" }, { role_name: "read" }, 1),
    });
    expectReview(result, "failure", 0, [1_000]);
    const notice = result.requests.findLast((entry) => entry.method === "PATCH");
    expect(notice?.body?.body).toContain("/allow-security-sensitive-change");
    expect(notice?.body?.body).not.toContain("informational");
    expect(
      result.reviews.findLast(
        (entry) => entry.body?.context === "openclaw/security-sensitive-review",
      )?.body?.state,
    ).toBe("failure");
  });

  it("recovers rate-limited notice writes instead of treating them as missing permissions", () => {
    const result = evaluate({
      "POST /repos/openclaw/openclaw/issues/7/labels": {
        responses: [{ httpError: 403, headers: { "retry-after": "60" } }, {}],
      },
    });
    expectReview(result, "success");
    expect(result.waits).toHaveLength(1);
    expect(result.stderr).not.toContain("Skipping");
  });

  it.each([
    {
      route: `GET ${pullPath}`,
      failure: { httpError: 429, headers: { "retry-after": "120" } },
      deadline: "2026-01-02T00:01:00Z",
    },
    { route: statusPath, failure: { httpError: 500 }, deadline: "2026-01-02T00:00:30Z" },
    {
      route: `GET ${pullPath}`,
      failure: { requestTimeout: "fetch" },
      deadline: "2026-01-02T00:01:00Z",
    },
    {
      route: `GET ${pullPath}/files`,
      failure: files.slice(0, 1),
      deadline: "2026-01-02T00:01:00Z",
    },
  ])("keeps $route recovery within the shared deadline", ({ route, failure, deadline }) => {
    const result = evaluate({ [route]: failure }, "enforce", Date.parse(deadline));
    expectReview(result, false, 1, []);
    expect(result.stderr).toContain("recovery budget exhausted");
  });

  it.each([rolePath, statusPath, historyPath])(
    "does not retry an ordinary permission rejection: %s",
    (route) => {
      const result = evaluate({ [route]: { httpError: 403 } });
      expectReview(result, route === statusPath ? ["pending"] : ["pending", "failure"], 1, []);
      expect(result.stderr).not.toBe("");
    },
  );

  it.each([
    { name: "unchanged PR", responses: [pr] },
    { name: "merged PR", responses: [pr, pr, pr, pr, pr, mergedPr] },
    {
      name: "advanced base and null metadata",
      responses: [
        { ...pr, maintainer_can_modify: undefined },
        { ...pr, base: { ...pr.base, sha: "e".repeat(40) }, maintainer_can_modify: null },
      ],
    },
  ])("requires CI and both guards on the actual head of an $name", ({ responses }) => {
    const result = evaluate({ [`GET ${pullPath}`]: { responses } });
    expectReview(result, ["pending", "success"]);
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
    expect(
      result.requests
        .filter((entry) => entry.path.includes("/statuses/"))
        .every((entry) => entry.path.endsWith(head)),
    ).toBe(true);
  });

  it("rechecks recorded PR identities before the combined success", () => {
    const result = evaluate({
      [historyPath]: { responses: [[], [], [otherReview]] },
      "GET /repos/openclaw/openclaw/pulls/8": { ...pr, number: 8 },
    });
    expectReview(result, false, 1);
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
    expectReview(result, ["pending", "success"]);
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
      expectReview(result, false, 1);
      expect(result.stderr).toContain("capacity is nearly exhausted");
      expect(
        result.requests.findLast((entry) => entry.body?.context === context)?.body?.state,
      ).toBe("failure");
    },
  );

  it.each([
    { name: "superseded head", changedPr: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } } },
    ...lifecycleChanges,
  ])("skips an ineligible $name at each workflow step", ({ name, changedPr }) => {
    for (const mode of ["detect", "autoscrub", "enforce"]) {
      const result = evaluate({ [`GET ${pullPath}`]: changedPr }, mode);
      expect(result.status, result.stderr).toBe(0);
      expect(result.requests.every((entry) => entry.method === "GET")).toBe(true);
      if (name === "superseded head") {
        expect(result.stdout).toContain("Superseded");
      }
    }
  });

  it.each(["before enforcement", "during review", "during recovery", "before publication"])(
    "finishes merged PR evidence %s without waiving missing approval",
    (phase) => {
      const result = evaluate({
        [`GET ${pullPath}`]: {
          responses:
            phase === "before enforcement"
              ? [mergedPr]
              : phase === "during recovery"
                ? [pr, pr, mergedPr]
                : phase === "before publication"
                  ? [pr, pr, pr, mergedPr]
                  : [pr, mergedPr],
        },
        [`GET ${pullPath}/files`]: {
          responses: phase === "during recovery" ? [files.slice(0, 1), files] : [files],
        },
        [rolePath]: { role_name: "read" },
      });
      expectReview(result, "failure");
      for (const context of ["openclaw/dependency-review", "openclaw/security-sensitive-review"]) {
        expect(
          result.reviews.findLast((entry) => entry.body?.context === context)?.body?.state,
        ).toBe("failure");
      }
      const notices = result.requests.map((entry) => entry.body?.body ?? "").join("\n");
      expect(notices).toContain("/allow-dependencies-change");
      expect(notices).toContain("/allow-security-sensitive-change");
      expect(result.stdout).not.toContain("skipping");
    },
  );

  it("keeps reading file pages after a merge so late sensitive files are reviewed", () => {
    const page = filePage();
    const result = evaluate({
      [`GET ${pullPath}`]: settles(
        { ...pr, changed_files: 202 },
        { ...mergedPr, changed_files: 202 },
      ),
      [`GET ${pullPath}/files`]: {
        responses: [
          { advanceMs: 15_000, response: page },
          { advanceMs: 15_000, response: page },
          files,
        ],
      },
      [rolePath]: { role_name: "read" },
    });
    expectReview(result, "failure");
    expect(result.requests.filter((entry) => entry.path === `${pullPath}/files`)).toHaveLength(3);
    expect(result.stdout).toContain("src/gateway/auth.ts");
  });

  it.each(["diff", "notice"])(
    "retains the original dependency base when a merge arrives during %s recovery",
    (kind) => {
      const result = evaluate({
        [`GET ${pullPath}`]: {
          settlesAt: kind === "diff" ? "2026-01-02T00:00:30Z" : "2026-01-02T00:00:01Z",
          before: pr,
          after: { ...mergedPr, base: { ...pr.base, sha: "e".repeat(40) } },
        },
        [`GET ${pullPath}/files`]: {
          responses: [
            ...(kind === "diff" ? [files.slice(0, 1)] : []),
            [files[0], { filename: "package.json", status: "modified" }],
          ],
        },
        [`GET /repos/openclaw/openclaw/compare/${pr.base.sha}...${head}`]: {
          base_commit: { sha: pr.base.sha },
          merge_base_commit: { sha: pr.base.sha },
        },
        [`GET /repos/openclaw/openclaw/dependency-graph/compare/${pr.base.sha}...${head}`]: [],
        [`GET /repos/openclaw/openclaw/contents/package.json?ref=${pr.base.sha}`]: {
          type: "file",
          content: Buffer.from('{"dependencies":{"fixture":"1"}}').toString("base64"),
        },
        [`GET /repos/openclaw/openclaw/contents/package.json?ref=${head}`]: {
          type: "file",
          content: Buffer.from('{"dependencies":{"fixture":"2"}}').toString("base64"),
        },
        [rolePath]: { role_name: "read" },
        ...(kind === "notice"
          ? {
              "POST /repos/openclaw/openclaw/issues/7/comments": {
                responses: [{ httpError: 500, recordCommentBeforeError: true }, {}],
              },
            }
          : {}),
      });
      expectReview(result, "failure", 0, kind === "diff" ? [30_000, 30_000] : [1_000]);
      expect(result.stdout).toContain("package.json");
      expect(result.stdout).toContain("/allow-dependencies-change");
    },
  );

  it.each(["before cleanup", "before commit"])(
    "preserves merged lockfiles %s and still reports their missing approval",
    (phase) => {
      const merged = {
        ...lockfilePr,
        state: "closed",
        merged: true,
        maintainer_can_modify: false,
      };
      const routes = {
        ...lockfileRoutes,
        [`GET ${pullPath}`]: {
          responses:
            phase === "before cleanup" ? [merged] : [lockfilePr, lockfilePr, lockfilePr, merged],
        },
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml`]: lockfileContents,
      };
      const cleanup = evaluate(routes, "autoscrub");
      expect(cleanup.status, cleanup.stderr).toBe(0);
      expect(cleanup.requests.some((entry) => entry.path === "/graphql")).toBe(false);
      const enforcement = evaluate({ ...routes, [`GET ${pullPath}`]: merged });
      expectReview(enforcement, "failure");
      expect(enforcement.stdout).toContain("/allow-dependencies-change");
    },
  );

  it.each([
    ...lifecycleChanges,
    { name: "merged PR", changedPr: mergedPr },
    { name: "superseded head", changedPr: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } } },
  ])("preserves an earlier guard error after a $name change", ({ changedPr }) => {
    const result = evaluate({
      [rolePath]: { httpError: 403 },
      [`GET ${pullPath}`]: changedAfter(2, changedPr),
    });
    expectReview(result, "failure", 1);
    expect(result.stderr).toContain("Fixture API failure");
    expect(result.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it.each([
    { ...pr, state: "unknown" },
    { ...pr, draft: "true" },
    { ...pr, base: { ...pr.base, ref: "" } },
    { ...pr, maintainer_can_modify: false },
    { ...pr, state: "closed", maintainer_can_modify: null },
    { ...mergedPr, user: { ...pr.user, id: 2 } },
    { ...pr, draft: true, user: { ...pr.user, id: 2 } },
    { ...pr, base: { ref: "stable", repo: { id: 3 } } },
  ])("keeps invalid or authority-changing transitions as failures: %j", (changedPr) => {
    const result = evaluate({ [`GET ${pullPath}`]: changedAfter(1, changedPr) });
    expectReview(result, false, 1);
    expect(result.stderr).toContain("pull request changed");
  });

  it.each([undefined, "main"])("does not treat an invalid live head %s as superseded", (sha) => {
    const result = evaluate({ [`GET ${pullPath}`]: { ...pr, head: { ...pr.head, sha } } });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("Superseded");
    expect(result.requests.some((entry) => entry.method !== "GET")).toBe(false);
  });

  const skippedRun = { ...run, id: 12, conclusion: "skipped" };
  const skippedJobs = { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: "skipped" }] };
  const skippedRunRoutes = {
    [`GET ${actions}/runs/12`]: skippedRun,
    [`GET ${actions}/runs/12/attempts/1/jobs`]: skippedJobs,
  };
  const fallback = { ...run, event: "workflow_dispatch", display_title: `CI release gate ${head}` };
  const skippedFallback = {
    ...skippedRun,
    event: "workflow_dispatch",
    display_title: `CI release gate ${head}`,
  };
  const listedRuns = (workflow_runs: object[]) => ({
    [runsPath]: { total_count: workflow_runs.length, workflow_runs },
  });

  describe("completion reconciliation", () => {
    const completedCi = { id: 10, attempt: 1 };
    const reconcile = (routes: Record<string, unknown>) =>
      evaluate(routes, "enforce", undefined, completedCi);
    const pending = { ...run, status: "in_progress" };
    const listed = (workflow_runs: object[]) => ({
      total_count: workflow_runs.length,
      workflow_runs,
    });
    it.each([
      {
        name: "missing completed run",
        routes: {
          [runsPath]: { responses: [listed([]), listed([run])] },
        },
      },
      {
        name: "stale pending listing",
        routes: {
          [runsPath]: { responses: [listed([pending]), listed([run])] },
        },
      },
      {
        name: "stale live attempt",
        routes: {
          [`GET ${actions}/runs/10`]: { responses: [pending, run] },
        },
      },
    ])("retries a $name before reporting success", ({ routes }) => {
      const result = reconcile(routes);
      expectReview(result, "success");
      expect(result.waits.reduce((sum, delay) => sum + delay, 0)).toBe(60_000);
    });

    it("fails the pass when the completed run remains missing", () => {
      const result = reconcile(listedRuns([]));
      expectReview(result, "failure", 1);
      expect(result.stderr).toContain("completed CI run is missing");
    });

    it.each([
      { name: "run", newer: { ...run, id: 11, status: "in_progress" } },
      { name: "attempt", newer: { ...run, run_attempt: 2, status: "in_progress" } },
    ])("keeps a newer active $name pending", ({ newer }) => {
      expectReview(reconcile(listedRuns([newer])), "pending", 0, []);
    });
  });

  // The last job is the gate, so only complete enumeration of every range succeeds.
  const jobPage = (from: number, count: number, total: number) => ({
    total_count: total,
    jobs: Array.from({ length: count }, (_, index) => ({
      name: from + index === total - 1 ? "openclaw/ci-gate" : `job ${from + index}`,
      status: "completed",
      conclusion: "success",
    })),
  });

  function ciCase(
    name: string,
    routes: Record<string, unknown>,
    outcome = "pending",
    status = 0,
    error = "",
    jobReads = 0,
  ) {
    return { name, routes, outcome, status, error, jobReads };
  }
  it.each([
    ciCase(
      "exact-head fallback",
      { ...listedRuns([fallback]), [`GET ${actions}/runs/10`]: fallback },
      "success",
    ),
    ciCase(
      "historical manual run",
      listedRuns([{ ...run, event: "workflow_dispatch", display_title: "CI" }]),
    ),
    ciCase(
      "paginated gate",
      {
        [jobsPath]: { responses: [jobPage(0, 100, 101), jobPage(100, 1, 101)] },
      },
      "success",
      0,
      "",
      2,
    ),
    ciCase(
      "delayed skipped workflow",
      { ...skippedRunRoutes, ...listedRuns([skippedRun, run]) },
      "success",
    ),
    ...[
      { status: "in_progress", conclusion: null, outcome: "pending" },
      { status: "completed", conclusion: "failure", outcome: "failure" },
    ].flatMap(({ status, conclusion, outcome }) => {
      const rerun = { ...skippedRun, run_attempt: 2, status, conclusion };
      const newer = { ...run, id: 11, status, conclusion };
      const currentJobs = { ...jobs, jobs: [{ ...jobs.jobs[0], status, conclusion }] };
      return [
        ciCase(
          `skipped workflow rerun ${status}`,
          {
            ...skippedRunRoutes,
            ...listedRuns([skippedRun, run]),
            [`GET ${actions}/runs/12`]: rerun,
            [`GET ${actions}/runs/12/attempts/2/jobs`]: currentJobs,
          },
          outcome,
        ),
        ciCase(
          `newer substantive run ${status}`,
          {
            ...skippedRunRoutes,
            ...listedRuns([run, skippedRun, newer]),
            [`GET ${actions}/runs/11`]: newer,
            [`GET ${actions}/runs/11/attempts/1/jobs`]: currentJobs,
          },
          outcome,
        ),
      ];
    }),
    ciCase("all workflows skipped", { ...skippedRunRoutes, ...listedRuns([skippedRun]) }),
    ciCase(
      "skipped release gate",
      {
        ...skippedRunRoutes,
        ...listedRuns([run, skippedFallback]),
        [`GET ${actions}/runs/12`]: skippedFallback,
      },
      "failure",
    ),
    ...[
      { name: "missing CI", runs: [] },
      { name: "unfinished CI", runs: [{ ...run, status: "in_progress" }] },
      { name: "another workflow", runs: [{ ...run, path: ".github/workflows/forged.yml" }] },
      { name: "stale head", runs: [{ ...run, head_sha: "d".repeat(40) }] },
      { name: "newer unfinished CI", runs: [run, { ...run, id: 11, status: "queued" }] },
    ].map(({ name, runs }) => ciCase(name, listedRuns(runs))),
    ...["failure", "skipped"].map((conclusion) =>
      ciCase(
        `${conclusion} gate`,
        {
          [jobsPath]: { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion }] },
        },
        "failure",
      ),
    ),
    ciCase("new attempt running", {
      [`GET ${actions}/runs/10`]: { ...run, run_attempt: 2, status: "in_progress" },
    }),
    ciCase(
      "completed replacement attempt",
      {
        [`GET ${actions}/runs/10`]: { ...run, run_attempt: 2 },
      },
      "failure",
      1,
      "completed CI attempt changed",
    ),
    ...[
      { name: "CI API failure", routes: { [runsPath]: { httpError: 403 } } },
      { name: "invalid CI list", routes: { [runsPath]: { workflow_runs: null } } },
      { name: "invalid job list", routes: { [jobsPath]: { jobs: null } } },
    ].map(({ name, routes }) => ciCase(name, routes, "failure", 1)),
  ])("uses current CI evidence for $name", ({ routes, status, outcome, error, jobReads }) => {
    const result = evaluate(routes);
    expectReview(result, ["pending", outcome], status);
    if (status === 1) {
      expect(result.stderr).not.toBe("");
    }
    if (error) {
      expect(result.stderr).toContain(error);
    }
    if (jobReads) {
      expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(
        jobReads,
      );
    }
  });

  it.each([
    {
      name: "the first page",
      pages: {
        "per_page=100&page=1": { httpError: 502 },
        "per_page=50&page=1": jobPage(0, 50, 60),
        "per_page=50&page=2": jobPage(50, 10, 60),
      },
    },
    {
      name: "a later page at two sizes",
      pages: {
        "per_page=100&page=1": jobPage(0, 100, 130),
        "per_page=100&page=2": { httpError: 502 },
        "per_page=50&page=3": { httpError: 502 },
        "per_page=25&page=5": jobPage(100, 25, 130),
        "per_page=25&page=6": jobPage(125, 5, 130),
      },
    },
  ])("lists the same CI job range at a smaller page size after 5xx on $name", ({ pages }) => {
    const result = evaluate({
      // Any request outside the expected page ranges fails the review.
      [jobsPath]: { httpError: 404 },
      ...Object.fromEntries(
        Object.entries(pages).map(([query, response]) => [`${jobsPath}?${query}`, response]),
      ),
    });
    expectReview(result, ["pending", "success"], 0, []);
    expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(
      Object.keys(pages).length,
    );
  });

  it("keeps normal read retries and fails closed when the smallest job page fails", () => {
    const result = evaluate({ [jobsPath]: { httpError: 502 } });
    expectReview(result, ["pending", "failure"], 1, [1_000, 2_000, 4_000]);
    expect(result.stderr).toContain("per_page=25&page=1 failed: 502");
    expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(6);
  });

  it.each([
    ...[
      { field: "status", value: "unknown" },
      { field: "run_attempt", value: undefined },
      { field: "run_attempt", value: 0 },
      { field: "id", value: undefined },
      { field: "id", value: 0 },
    ].flatMap(({ field, value }) => {
      const malformed = { ...run, [field]: value };
      return [
        { name: `listed ${field}=${value}`, routes: listedRuns([malformed]), error: "" },
        {
          name: `live ${field}=${value}`,
          routes: { [`GET ${actions}/runs/10`]: malformed },
          error: "",
        },
      ];
    }),
    ...[
      { field: "id", value: 13 },
      { field: "head_sha", value: "d".repeat(40) },
      { field: "run_attempt", value: 0 },
      { field: "status", value: "unknown" },
    ].map(({ field, value }) => ({
      name: `skipped ${field}`,
      routes: {
        ...skippedRunRoutes,
        ...listedRuns([skippedRun, run]),
        [`GET ${actions}/runs/12`]: { ...skippedRun, [field]: value },
      },
      error: "",
    })),
    ...[0, undefined].map((id) => ({
      name: `newer invalid ID ${id}`,
      routes: listedRuns([run, { ...run, id, status: "queued" }]),
      error: "invalid run identity",
    })),
  ])("rejects malformed CI identity: $name", ({ routes, error }) => {
    const result = evaluate(routes);
    expectReview(result, ["pending", "failure"], 1);
    if (error) {
      expect(result.stderr).toContain(error);
    }
  });

  it.each(["src/gateway/auth.ts", "pnpm-workspace.yaml"])(
    "keeps the combined gate closed when only %s requires approval",
    (filename) => {
      const result = evaluate({
        [rolePath]: { role_name: "write" },
        [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
        [`GET ${pullPath}/files`]: [{ filename, status: "modified" }],
      });
      expectReview(result, "failure");
      expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(1);
    },
  );

  it("does not hide a guard error when the other guard awaits approval", () => {
    const result = evaluate({
      [rolePath]: { responses: [{ httpError: 403 }, { role_name: "write" }] },
    });
    expectReview(result, false, 1);
    expect(result.stderr).toContain("Fixture API failure");
    expect(
      result.requests.some((entry) =>
        entry.body?.body?.includes("/allow-security-sensitive-change"),
      ),
    ).toBe(true);
  });

  it("publishes both review notices and settles automatically after command approval", () => {
    const result = evaluate({ [rolePath]: { role_name: "write" } });
    expectReview(result, ["pending", "failure"]);
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
    expect(result.reviews.every((entry) => entry.body?.state === "failure")).toBe(true);
    const approved = evaluate({
      [rolePath]: { role_name: "write" },
      "GET /repos/openclaw/openclaw/collaborators/reviewer/permission": { role_name: "maintain" },
      "GET /repos/openclaw/openclaw/issues/7/comments": [
        ...notices.map((entry, index) => ({
          id: index + 1,
          body: entry.body?.body,
          user: { login: "github-actions[bot]", type: "Bot" },
          updated_at: "2026-01-01T00:00:00Z",
        })),
        {
          id: 3,
          user: { id: 2, login: "reviewer", type: "User" },
          body: "/allow-dependencies-change\n/allow-security-sensitive-change",
          created_at: "2026-01-01T00:01:00Z",
          updated_at: "2026-01-01T00:01:00Z",
          html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-3",
        },
      ],
    });
    expectReview(approved, "success");
    expect(approved.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
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
    expectReview(result, false);
    expect(result.stdout).toContain("approval changed");
  });

  it.each([
    {
      name: "head",
      changedPr: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
      changedFields: [],
    },
    ...lifecycleChanges.map(({ name, changedPr }) => ({ name, changedPr, changedFields: [] })),
    {
      name: "missing head",
      changedPr: { ...pr, head: { ...pr.head, sha: undefined } },
      changedFields: ["head.sha"],
    },
    {
      name: "author and edit permission",
      changedPr: {
        ...pr,
        user: { id: 2, login: "changed-author", type: "Bot" },
        maintainer_can_modify: false,
      },
      changedFields: ["user.id", "user.login", "user.type", "maintainer_can_modify"],
    },
  ])("does not publish combined success after a changed $name", ({ changedPr, changedFields }) => {
    const result = evaluate({
      [`GET ${pullPath}`]: changedAfter(5, changedPr),
    });
    const obsolete = changedFields.length === 0;
    expect(result.status).toBe(obsolete ? 0 : 1);
    expect(result.combined).not.toContain("success");
    if (obsolete) {
      expect(result.stdout).toContain("skipping");
      expect(result.stderr).toBe("");
      expect(result.requests.at(-1)).toMatchObject({ method: "GET", path: pullPath });
      expect(
        result.requests
          .filter((entry) => entry.method === "POST" && entry.path.includes("/statuses/"))
          .every((entry) => entry.path.endsWith(head)),
      ).toBe(true);
    } else {
      // Only fixed field names belong in the diagnostic, never the PR's values.
      expect(result.stderr.trim()).toBe(
        `The pull request changed during security review (changed fields: ${changedFields.join(", ")}); the next automatic event will evaluate it.`,
      );
    }
  });

  const exemptRoutes = {
    "GET /repos/openclaw/openclaw/pulls/152415": { ...rollout, merged_at: "2026-02-01T00:00:00Z" },
    [`GET /repos/openclaw/openclaw/compare/${landed}...${head}`]: {
      base_commit: { sha: landed },
      merge_base_commit: { sha: "b".repeat(40) },
      status: "diverged",
    },
  };

  it.each([true, false])(
    "grandfathers an old branch without reusable guard evidence (CI=%s)",
    (hasCi) => {
      const result = evaluate({
        ...exemptRoutes,
        ...(hasCi ? {} : { [runsPath]: { total_count: 0, workflow_runs: [] } }),
      });
      expectReview(result, ["pending", hasCi ? "success" : "pending"]);
      expect(result.reviews).toEqual([]);
      expect(result.requests.some((entry) => entry.path.includes("/issues/"))).toBe(false);
      expect(result.requests.some((entry) => entry.path.endsWith("/files"))).toBe(false);
    },
  );

  it("does not autoscrub a grandfathered PR", () => {
    const result = evaluate(exemptRoutes, "autoscrub");
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.requests
        .filter((entry) => entry.method !== "GET")
        .every((entry) => entry.body?.context === "openclaw/ci-gate"),
    ).toBe(true);
  });

  it("leaves the combined gate failed when rollout metadata cannot be read", () => {
    const result = evaluate({ "GET /repos/openclaw/openclaw/pulls/152415": { httpError: 403 } });
    expectReview(result, ["pending", "failure"], 1);
    expect(result.reviews).toEqual([]);
  });
});
