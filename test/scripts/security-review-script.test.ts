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

describe("combined security review entry point", () => {
  it("recovers a temporary HTTP 500 without failing the review", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: { responses: [{ httpError: 500 }, pr] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    expect(result.combined.at(-1)).toBe("success");
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
  });

  it.each([
    { route: `GET ${pullPath}`, response: pr, requestTimeout: "fetch" },
    { route: rolePath, response: { role_name: "maintain" }, requestTimeout: "body" },
    { route: jobsPath, response: jobs, requestTimeout: "fetch" },
  ])(
    "restarts evaluation after a $requestTimeout deadline on $route",
    ({ route, response, requestTimeout }) => {
      const result = evaluate({ [route]: { responses: [{ requestTimeout }, response] } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.waits).toEqual([1_000]);
      const afterWait = result.requests.slice(
        result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
      );
      expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
      expect(result.combined.at(-1)).toBe("success");
    },
  );

  it("recovers the dependency-graph read deadline without granting contributor approval", () => {
    const graphPath = `/repos/openclaw/openclaw/dependency-graph/compare/${pr.base.sha}...${head}`;
    const result = evaluate({
      [rolePath]: { role_name: "read" },
      [`GET ${pullPath}/files`]: [files[0], { filename: "pnpm-lock.yaml", status: "modified" }],
      [`GET ${graphPath}`]: { responses: [{ requestTimeout: "fetch" }, []] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    expect(result.requests.filter((entry) => entry.path === graphPath)).toHaveLength(2);
    expect(result.combined.at(-1)).toBe("failure");
    expect(result.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
    expect(result.stdout).toContain("awaiting maintainer approval");
  });

  it("rereads author authority after a read deadline instead of retaining approval", () => {
    const result = evaluate({
      [jobsPath]: { responses: [{ requestTimeout: "fetch" }, jobs] },
      [rolePath]: {
        settlesAt: "2026-01-02T00:00:30Z",
        before: { role_name: "maintain" },
        after: { role_name: "read" },
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    const afterWait = result.requests.slice(
      result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
    );
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(afterWait.some((entry) => entry.body?.state === "success")).toBe(false);
    expect(result.combined.at(-1)).toBe("failure");
  });

  it("recovers a lockfile read deadline before submitting one cleanup commit", () => {
    const result = evaluate(
      {
        [`GET ${pullPath}`]: {
          ...pr,
          changed_files: 1,
          head: { ...pr.head, repo: { id: 1, full_name: "openclaw/openclaw" } },
        },
        [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml", status: "modified" }],
        [rolePath]: { role_name: "read" },
        [`GET /repos/openclaw/openclaw/dependency-graph/compare/${pr.base.sha}...${head}`]: [],
        [`GET /repos/openclaw/openclaw/compare/${pr.base.sha}...${head}`]: {
          base_commit: { sha: pr.base.sha },
          merge_base_commit: { sha: pr.base.sha },
        },
        [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=${pr.base.sha}`]: {
          responses: [
            { requestTimeout: "fetch" },
            {
              type: "file",
              encoding: "base64",
              content: Buffer.from("lockfileVersion: '9.0'\n").toString("base64"),
            },
          ],
        },
        "POST /graphql": { data: { createCommitOnBranch: { commit: { oid: "e".repeat(40) } } } },
      },
      "autoscrub",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    const afterWait = result.requests.slice(
      result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
    );
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(result.requests.filter((entry) => entry.path === "/graphql")).toHaveLength(1);
  });

  it.each([
    {
      name: "HTTP permission denial",
      response: { httpError: 403, message: "Resource not accessible by integration" },
      unavailable: true,
    },
    {
      name: "GraphQL permission denial",
      response: {
        errors: [
          {
            type: "FORBIDDEN",
            path: ["createCommitOnBranch"],
            message: "Resource not accessible by integration",
          },
        ],
      },
      unavailable: true,
    },
    { name: "unknown HTTP 403", response: { httpError: 403 }, unavailable: false },
    { name: "invalid credentials", response: { httpError: 401 }, unavailable: false },
    { name: "missing repository", response: { httpError: 404 }, unavailable: false },
    {
      name: "stale head",
      response: { errors: [{ type: "STALE_DATA", message: "Expected branch head to match" }] },
      unavailable: false,
    },
    {
      name: "mixed GraphQL errors",
      response: {
        errors: [{ type: "FORBIDDEN", path: ["createCommitOnBranch"] }, { type: "INTERNAL" }],
      },
      unavailable: false,
    },
    {
      name: "commit response field denial",
      response: {
        errors: [{ type: "FORBIDDEN", path: ["createCommitOnBranch", "commit", "oid"] }],
      },
      unavailable: false,
    },
    {
      name: "partial commit response",
      response: {
        data: { createCommitOnBranch: { commit: { oid: "e".repeat(40) } } },
        errors: [{ type: "FORBIDDEN", path: ["createCommitOnBranch"] }],
      },
      unavailable: false,
    },
    {
      name: "base read permission denial",
      response: { httpError: 403, message: "Resource not accessible by integration" },
      unavailable: false,
      baseReadDenied: true,
    },
  ])("keeps cleanup $name separate from dependency approval", (scenario) => {
    const { response, unavailable } = scenario;
    const baseReadDenied = "baseReadDenied" in scenario && scenario.baseReadDenied;
    const routes = {
      [`GET ${pullPath}`]: {
        ...pr,
        changed_files: 1,
        maintainer_can_modify: true,
        head: { ...pr.head, repo: { id: 2, full_name: "contributor/openclaw" } },
      },
      [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml", status: "modified" }],
      [rolePath]: { role_name: "read" },
      [`GET /repos/openclaw/openclaw/dependency-graph/compare/${pr.base.sha}...${head}`]: [],
      [`GET /repos/openclaw/openclaw/compare/${pr.base.sha}...${head}`]: {
        base_commit: { sha: pr.base.sha },
        merge_base_commit: { sha: pr.base.sha },
      },
      [`GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml`]: baseReadDenied
        ? response
        : {
            type: "file",
            encoding: "base64",
            content: Buffer.from("lockfileVersion: '9.0'\n").toString("base64"),
          },
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
      expect(enforcement.status, enforcement.stderr).toBe(0);
      expect(enforcement.combined.at(-1)).toBe("failure");
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
  });

  it("does not replay a failed notice write when a sibling read later times out", () => {
    const commentPath = "/repos/openclaw/openclaw/issues/7/comments";
    const result = evaluate({
      [`POST ${commentPath}`]: { httpError: 500 },
      [rolePath]: {
        responses: [
          { role_name: "maintain" },
          { role_name: "maintain" },
          { requestTimeout: "fetch" },
        ],
      },
    });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([]);
    expect(
      result.requests.filter((entry) => entry.method === "POST" && entry.path === commentPath),
    ).toHaveLength(1);
    expect(result.combined.at(-1)).toBe("failure");
    expect(result.stderr).toContain(`GitHub API POST ${commentPath} failed: 500`);
  });

  it("bounds persistent read deadlines without granting approval", () => {
    const result = evaluate({ [rolePath]: { requestTimeout: "fetch" } });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([1_000, 2_000, 4_000]);
    expect(result.requests.filter((entry) => `GET ${entry.path}` === rolePath)).toHaveLength(4);
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
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
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([]);
    expect(
      result.requests.filter((entry) => `${entry.method} ${entry.path}` === route),
    ).toHaveLength(1);
    expect(result.stderr).toContain("exceeded timeout 30000ms");
    expect(result.combined).not.toContain("success");
  });

  it("exhausts HTTP 500 retries without publishing approval", () => {
    const result = evaluate({ [`GET ${pullPath}`]: { httpError: 500 } });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([1_000, 2_000, 4_000]);
    expect(result.requests.filter((entry) => entry.path === pullPath)).toHaveLength(4);
    expect(result.stderr).toContain(`GitHub API GET ${pullPath} failed: 500`);
    expect(
      result.requests.every((entry) => entry.method === "GET" || entry.method === "WAIT"),
    ).toBe(true);
  });

  it.each([
    { name: "partial file list", initialPr: pr, initialFiles: files.slice(0, 1) },
    { name: "stale file count", initialPr: { ...pr, changed_files: 3 }, initialFiles: files },
  ])("recovers a $name before evaluating either guard", ({ initialPr, initialFiles }) => {
    const result = evaluate({
      [`GET ${pullPath}`]: { responses: [initialPr, pr] },
      [`GET ${pullPath}/files`]: { responses: [initialFiles, files] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([30_000, 30_000]);
    expect(result.requests.filter((entry) => entry.path === `${pullPath}/files`)).toHaveLength(2);
    expect(result.combined.at(-1)).toBe("success");
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
  });

  it.each(["detect", "enforce"])(
    "recovers diff data that takes longer than seven seconds to settle in %s mode",
    (mode) => {
      const result = evaluate(
        {
          [`GET ${pullPath}`]: {
            settlesAt: "2026-01-02T00:00:30Z",
            before: { ...pr, changed_files: 3146 },
            after: pr,
          },
          [`GET ${pullPath}/files`]: {
            settlesAt: "2026-01-02T00:00:30Z",
            before: files.slice(0, 1),
            after: files,
          },
        },
        mode,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.waits.some((delay) => delay >= 30_000)).toBe(true);
      expect(result.requests.filter((entry) => entry.path === `${pullPath}/files`)).toHaveLength(2);
      if (mode === "enforce") {
        expect(result.combined.at(-1)).toBe("success");
        expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
      }
    },
  );

  it.each([
    { phase: "before dependency approval", stableReads: 2 },
    { phase: "between guards", stableReads: 3 },
    { phase: "before combined success", stableReads: 5 },
  ])("restarts the complete review when the file count changes $phase", ({ stableReads }) => {
    const changed = { ...pr, changed_files: 3 };
    const result = evaluate({
      [`GET ${pullPath}`]: {
        responses: [...Array.from({ length: stableReads }, () => ({ ...pr })), changed],
      },
      [`GET ${pullPath}/files`]: {
        responses: [files, [...files, { filename: "src/secrets/store.ts", status: "modified" }]],
      },
      [rolePath]: {
        settlesAt: "2026-01-02T00:00:30Z",
        before: { role_name: "maintain" },
        after: { role_name: "read" },
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([30_000, 30_000]);
    const afterWait = result.requests.slice(
      result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
    );
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(afterWait.some((entry) => entry.body?.state === "success")).toBe(false);
    expect(result.combined.at(-1)).toBe("failure");
    expect(afterWait.map((entry) => entry.body?.body ?? "").join("\n")).toContain(
      "src/secrets/store.ts",
    );
  });

  it("restarts incomplete pagination and still requires approval for recovered sensitive files", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `docs/example-${index}.md`,
      status: "modified",
    }));
    const result = evaluate({
      [`GET ${pullPath}`]: { ...pr, changed_files: 102 },
      [`GET ${pullPath}/files`]: { responses: [firstPage, [], firstPage, files] },
      [rolePath]: { role_name: "read" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([30_000, 30_000]);
    expect(result.combined.at(-1)).toBe("failure");
    expect(result.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
    const notices = result.requests.map((entry) => entry.body?.body ?? "").join("\n");
    expect(notices).toContain("/allow-dependencies-change");
    expect(notices).toContain("/allow-security-sensitive-change");
  });

  it.each([
    { name: "head", changedPr: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } }, status: 0 },
    { name: "target branch", changedPr: { ...pr, base: { ...pr.base, ref: "stable" } }, status: 1 },
    {
      name: "author",
      changedPr: { ...pr, user: { id: 2, login: "other-author", type: "User" } },
      status: 1,
    },
    { name: "state", changedPr: { ...pr, state: "closed" }, status: 1 },
  ])("stops for a changed $name during file-list recovery", ({ changedPr, status }) => {
    const result = evaluate({
      [`GET ${pullPath}`]: { responses: [pr, pr, changedPr] },
      [`GET ${pullPath}/files`]: { responses: [files.slice(0, 1), files] },
    });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toContain(
      status === 0 ? "Superseded" : "pull request changed",
    );
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it.each(["detect", "autoscrub", "enforce"])(
    "stops superseded diff recovery at its first checkpoint in %s mode",
    (mode) => {
      const result = evaluate(
        {
          [`GET ${pullPath}`]: {
            settlesAt: "2026-01-02T00:00:30Z",
            before: pr,
            after: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
          },
          [`GET ${pullPath}/files`]: files.slice(0, 1),
        },
        mode,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Superseded");
      expect(result.waits).toEqual([30_000]);
      expect(result.requests.filter((entry) => entry.path === pullPath + "/files")).toHaveLength(1);
      const afterWait = result.requests.slice(
        result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
      );
      expect(afterWait).toEqual([{ method: "GET", path: pullPath }]);
      expect(result.combined).not.toContain("success");
    },
  );

  it.each([false, true])(
    "checks the head before more slow file pages (superseded=%s)",
    (superseded) => {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        filename: "docs/page-" + index + ".md",
        status: "modified",
      }));
      const original = { ...pr, changed_files: 202 };
      const result = evaluate({
        [`GET ${pullPath}`]: {
          settlesAt: "2026-01-02T00:00:30Z",
          before: original,
          after: superseded ? { ...original, head: { ...pr.head, sha: "d".repeat(40) } } : original,
        },
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([30_000, 10_000]);
    expect(result.combined.at(-1)).toBe("success");
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
    expect(result.status, result.stderr).toBe(0);
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
    expect(result.combined).not.toContain("success");
  });

  it("fails closed when a recovery checkpoint cannot read the PR", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: { responses: [pr, pr, { httpError: 403 }] },
      [`GET ${pullPath}/files`]: files.slice(0, 1),
    });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([30_000]);
    expect(result.stderr).toContain("Fixture API failure");
    expect(result.combined.at(-1)).toBe("failure");
  });

  it("bounds file-list recovery across both guards and reports the conflicting counts", () => {
    const result = evaluate({ [`GET ${pullPath}/files`]: files.slice(0, 1) });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual(Array<number>(14).fill(30_000));
    expect(result.requests.filter((entry) => entry.path === `${pullPath}/files`)).toHaveLength(4);
    expect(result.stderr).toContain("expected 2, received 1, current count 2");
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.stderr).not.toContain("Split the PR");
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
    expect(result.combined.at(-1)).toBe("failure");
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
      expect(result.status, result.stderr).toBe(0);
      expect(result.waits).toHaveLength(1);
      expect(result.waits[0]).toBeGreaterThanOrEqual(minimum);
      expect(result.waits[0]).toBeLessThan(minimum + 17_000);
      expect(result.combined.at(-1)).toBe("success");
      expect(result.environment).toBe(
        `OPENCLAW_SECURITY_REVIEW_DEADLINE_MS=${Date.parse("2026-01-02T01:05:00Z")}\n`,
      );
    },
  );

  it.each([
    { httpError: 500 },
    { httpError: 502 },
    { httpError: 503 },
    { httpError: 504 },
    { transportError: "ECONNRESET" },
  ])("restarts evaluation after a transient status publication failure: %j", (failure) => {
    const result = evaluate({ [statusPath]: { responses: [failure, {}] } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    const afterWait = result.requests.slice(
      result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
    );
    expect(afterWait[0]).toMatchObject({ method: "GET", path: pullPath });
    expect(result.combined.at(-1)).toBe("success");
  });

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
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toHaveLength(1);
    const afterWait = result.requests.slice(
      result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
    );
    expect(afterWait[0]?.path).toBe(pullPath);
    expect(afterWait.some((entry) => entry.body?.state === "success")).toBe(false);
    expect(result.combined.at(-1)).toBe("failure");
  });

  it("stops after the head changes while recovering a failed success write", () => {
    const result = evaluate({
      [statusPath]: { responses: [{}, {}, { httpError: 500 }, {}] },
      [`GET ${pullPath}`]: {
        responses: [pr, pr, pr, { ...pr, head: { ...pr.head, sha: "d".repeat(40) } }],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    expect(result.stdout).toContain("Superseded");
    const afterWait = result.requests.slice(
      result.requests.findIndex((entry) => entry.method === "WAIT") + 1,
    );
    expect(afterWait.every((entry) => entry.method === "GET")).toBe(true);
    expect(result.combined).not.toContain("success");
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
      expect(result.status, result.stderr).toBe(0);
      expect(result.waits).toHaveLength(1);
      expect(result.waits[0]).toBeGreaterThanOrEqual(minimumDelay);
      expect(result.waits[0]).toBeLessThan(minimumDelay + 17_000);
      expect(result.combined.at(-1)).toBe("success");
    },
  );

  it("rereads CI after a failed combined-success publication", () => {
    const result = evaluate({
      [statusPath]: { responses: [{}, {}, {}, {}, {}, { httpError: 500 }, {}] },
      [jobsPath]: {
        responses: [jobs, { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion: "failure" }] }],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toEqual([1_000]);
    expect(result.combined.at(-1)).toBe("failure");
    expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(2);
  });

  it("bounds persistent status publication failures without granting approval", () => {
    const result = evaluate({ [statusPath]: { httpError: 500 } });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([1_000, 2_000, 4_000]);
    expect(result.requests.filter((entry) => entry.method === "POST")).toHaveLength(4);
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it("shares three evaluation restarts between status failures and rate limits", () => {
    const result = evaluate({
      [statusPath]: {
        responses: [{ httpError: 500 }, { httpError: 429 }, { httpError: 500 }],
      },
    });
    expect(result.status).toBe(1);
    expect(result.waits).toHaveLength(3);
    expect(result.waits[0]).toBe(1_000);
    expect(result.waits[1]).toBeGreaterThanOrEqual(120_000);
    expect(result.waits[1]).toBeLessThan(137_000);
    expect(result.waits[2]).toBe(4_000);
    expect(result.requests.filter((entry) => entry.method === "POST")).toHaveLength(4);
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.combined).not.toContain("success");
  });

  it.each([
    { name: "comment only", statusReplies: [{}] },
    { name: "failure report also fails", statusReplies: [{}, {}, {}, {}, {}, { httpError: 500 }] },
    { name: "sibling status also fails", statusReplies: [{}, {}, {}, { httpError: 500 }, {}] },
  ])("does not restart evaluation for a failed comment publication: $name", ({ statusReplies }) => {
    const commentPath = "/repos/openclaw/openclaw/issues/7/comments";
    const result = evaluate({
      [statusPath]: { responses: statusReplies },
      [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
      [`GET ${pullPath}/files`]: [files[1]],
      [`POST ${commentPath}`]: { httpError: 500 },
    });
    expect(result.status).toBe(1);
    expect(result.waits).toEqual([]);
    expect(
      result.requests.filter((entry) => entry.method === "POST" && entry.path === commentPath),
    ).toHaveLength(1);
    expect(result.combined.at(-1)).toBe("failure");
    expect(result.stderr).toContain(`GitHub API POST ${commentPath} failed: 500`);
  });

  it("recovers rate-limited notice writes instead of treating them as missing permissions", () => {
    const result = evaluate({
      "POST /repos/openclaw/openclaw/issues/7/labels": {
        responses: [{ httpError: 403, headers: { "retry-after": "60" } }, {}],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.waits).toHaveLength(1);
    expect(result.combined.at(-1)).toBe("success");
    expect(result.stderr).not.toContain("Skipping");
  });

  it("stops rate-limit recovery after three restarts without publishing success", () => {
    const result = evaluate({ [rolePath]: { httpError: 429 } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.waits).toHaveLength(3);
    for (const [index, delay] of result.waits.entries()) {
      expect(delay).toBeGreaterThanOrEqual(60_000 * 2 ** index);
    }
    expect(result.requests.some((entry) => entry.body?.state === "success")).toBe(false);
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
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recovery budget exhausted");
    expect(result.waits).toEqual([]);
    expect(result.combined).not.toContain("success");
  });

  it.each([rolePath, statusPath])(
    "does not retry an ordinary permission rejection: %s",
    (route) => {
      const result = evaluate({ [route]: { httpError: 403 } });
      expect(result.status).toBe(1);
      expect(result.waits).toEqual([]);
      expect(result.combined).toEqual(route === rolePath ? ["pending", "failure"] : ["pending"]);
    },
  );

  it("requires successful CI and both guard decisions on the actual PR head", () => {
    const result = evaluate();
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "success"]);
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
    expect(
      result.requests
        .filter((entry) => entry.path.includes("/statuses/"))
        .every((entry) => entry.path.endsWith(head)),
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
    expect(result.combined).toEqual(["pending", "success"]);
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

  it.each(["detect", "autoscrub", "enforce"])(
    "skips a superseded scheduled head in %s mode without mutations",
    (mode) => {
      const result = evaluate(
        {
          [`GET ${pullPath}`]: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
        },
        mode,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Superseded");
      expect(result.requests.some((entry) => entry.method !== "GET")).toBe(false);
    },
  );

  it.each([undefined, "", "main"])(
    "does not treat an invalid live head %s as superseded",
    (sha) => {
      const result = evaluate({ [`GET ${pullPath}`]: { ...pr, head: { ...pr.head, sha } } });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("Superseded");
      expect(result.requests.some((entry) => entry.method !== "GET")).toBe(false);
    },
  );

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
    expect(result.combined).toEqual(["pending", "success"]);
  });

  it("does not accept a manual historical-target run as current PR proof", () => {
    const result = evaluate({
      [runsPath]: {
        total_count: 1,
        workflow_runs: [{ ...run, event: "workflow_dispatch", display_title: "CI" }],
      },
    });
    expect(result.status, result.stderr).toBe(0);
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
    expect(result.combined).toEqual(["pending", "success"]);
    expect(result.requests.filter((entry) => `GET ${entry.path}` === jobsPath)).toHaveLength(2);
  });

  const skippedRun = { ...run, id: 12, conclusion: "skipped" };
  const skippedJobs = {
    ...jobs,
    jobs: [{ ...jobs.jobs[0], conclusion: "skipped" }],
  };
  const skippedRunRoutes = {
    [`GET ${actions}/runs/12`]: skippedRun,
    [`GET ${actions}/runs/12/attempts/1/jobs`]: skippedJobs,
  };

  it("ignores a delayed skipped PR workflow after successful same-head CI", () => {
    const result = evaluate({
      ...skippedRunRoutes,
      [runsPath]: { total_count: 2, workflow_runs: [skippedRun, run] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "success"]);
  });

  it.each([
    { status: "in_progress", conclusion: null, expected: "pending" },
    { status: "completed", conclusion: "failure", expected: "failure" },
  ])(
    "rechecks a skipped run before ignoring its $status rerun",
    ({ status, conclusion, expected }) => {
      const currentRun = { ...skippedRun, run_attempt: 2, status, conclusion };
      const result = evaluate({
        ...skippedRunRoutes,
        [runsPath]: { total_count: 2, workflow_runs: [skippedRun, run] },
        [`GET ${actions}/runs/12`]: currentRun,
        [`GET ${actions}/runs/12/attempts/2/jobs`]: {
          ...jobs,
          jobs: [{ ...jobs.jobs[0], status, conclusion }],
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.combined).toEqual(["pending", expected]);
    },
  );

  it.each([
    { field: "id", value: 13 },
    { field: "head_sha", value: "d".repeat(40) },
    { field: "run_attempt", value: 0 },
    { field: "status", value: "unknown" },
  ])("rejects invalid live skipped-run metadata: $field", ({ field, value }) => {
    const result = evaluate({
      ...skippedRunRoutes,
      [runsPath]: { total_count: 2, workflow_runs: [skippedRun, run] },
      [`GET ${actions}/runs/12`]: { ...skippedRun, [field]: value },
    });
    expect(result.status).toBe(1);
    expect(result.combined).toEqual(["pending", "failure"]);
  });

  it.each([
    { status: "completed", conclusion: "failure", expected: "failure" },
    { status: "completed", conclusion: "cancelled", expected: "failure" },
    { status: "in_progress", conclusion: null, expected: "pending" },
  ])(
    "keeps newer substantive CI authoritative before a skipped PR workflow: $status/$conclusion",
    ({ status, conclusion, expected }) => {
      const currentRun = { ...run, id: 11, status, conclusion };
      const result = evaluate({
        ...skippedRunRoutes,
        [runsPath]: { total_count: 3, workflow_runs: [run, skippedRun, currentRun] },
        [`GET ${actions}/runs/11`]: currentRun,
        [`GET ${actions}/runs/11/attempts/1/jobs`]: {
          ...jobs,
          jobs: [{ ...jobs.jobs[0], status, conclusion }],
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.combined).toEqual(["pending", expected]);
    },
  );

  it("does not approve when every matching CI workflow was skipped", () => {
    const result = evaluate({
      ...skippedRunRoutes,
      [runsPath]: { total_count: 1, workflow_runs: [skippedRun] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "pending"]);
  });

  it("does not ignore a skipped explicit CI release gate", () => {
    const fallback = {
      ...skippedRun,
      event: "workflow_dispatch",
      display_title: `CI release gate ${head}`,
    };
    const result = evaluate({
      ...skippedRunRoutes,
      [runsPath]: { total_count: 2, workflow_runs: [run, fallback] },
      [`GET ${actions}/runs/12`]: fallback,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "failure"]);
  });

  it.each([
    { name: "missing CI", response: { total_count: 0, workflow_runs: [] } },
    {
      name: "unfinished CI",
      response: { total_count: 1, workflow_runs: [{ ...run, status: "in_progress" }] },
      current: { ...run, status: "in_progress" },
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
      current: { ...run, id: 11, status: "queued" },
    },
  ])("does not turn $name into a passing combined gate", ({ response, current }) => {
    const result = evaluate({
      [runsPath]: response,
      ...(current ? { [`GET ${actions}/runs/${current.id}`]: current } : {}),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "pending"]);
    expect(result.requests.some((entry) => entry.path.endsWith("/jobs"))).toBe(false);
  });

  it("settles completed CI when the run list still reports its previous attempt in progress", () => {
    const current = { ...run, run_attempt: 2 };
    const result = evaluate({
      [runsPath]: { total_count: 1, workflow_runs: [{ ...run, status: "in_progress" }] },
      [`GET ${actions}/runs/10`]: current,
      [`GET ${actions}/runs/10/attempts/2/jobs`]: jobs,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "success"]);
    expect(result.requests.filter((entry) => entry.path.endsWith("/jobs"))).toEqual([
      expect.objectContaining({ path: `${actions}/runs/10/attempts/2/jobs` }),
    ]);
  });

  it.each([
    { field: "id", value: 11 },
    { field: "head_sha", value: "d".repeat(40) },
    { field: "head_branch", value: "other-branch" },
    { field: "path", value: ".github/workflows/other.yml" },
    { field: "repository", value: { id: 2 } },
    { field: "event", value: "push" },
  ])("rejects a changed $field when refreshing an unfinished run", ({ field, value }) => {
    const result = evaluate({
      [runsPath]: { total_count: 1, workflow_runs: [{ ...run, status: "in_progress" }] },
      [`GET ${actions}/runs/10`]: { ...run, [field]: value },
    });
    expect(result.status).toBe(1);
    expect(result.combined).toEqual(["pending", "failure"]);
    expect(result.requests.some((entry) => entry.path.endsWith("/jobs"))).toBe(false);
  });

  it.each([
    { field: "status", value: undefined },
    { field: "status", value: "unknown" },
    { field: "run_attempt", value: undefined },
    { field: "run_attempt", value: 0 },
    { field: "id", value: undefined },
    { field: "id", value: 0 },
  ])("fails malformed CI metadata instead of waiting: $field=$value", ({ field, value }) => {
    const malformed = { ...run, [field]: value };
    for (const routes of [
      { [runsPath]: { total_count: 1, workflow_runs: [malformed] } },
      { [`GET ${actions}/runs/10`]: malformed },
    ]) {
      const result = evaluate(routes);
      expect(result.status).toBe(1);
      expect(result.combined).toEqual(["pending", "failure"]);
    }
  });

  it.each([0, -1, undefined, "invalid"])(
    "rejects malformed eligible run ID %s before selecting older successful CI",
    (id) => {
      const result = evaluate({
        [runsPath]: {
          total_count: 2,
          workflow_runs: [run, { ...run, id, status: "queued" }],
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid run identity");
      expect(result.combined).toEqual(["pending", "failure"]);
    },
  );

  it.each(["failure", "cancelled", "skipped", "neutral"])(
    "does not hide a %s CI gate",
    (conclusion) => {
      const result = evaluate({ [jobsPath]: { ...jobs, jobs: [{ ...jobs.jobs[0], conclusion }] } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.combined).not.toContain("success");
    },
  );

  it("does not accept a previously successful CI attempt while a new attempt runs", () => {
    const result = evaluate({
      [`GET ${actions}/runs/10`]: { ...run, run_attempt: 2, status: "in_progress" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "pending"]);
  });

  it("fails evaluation when a replacement CI attempt has already completed", () => {
    const result = evaluate({
      [`GET ${actions}/runs/10`]: { ...run, run_attempt: 2 },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("completed CI attempt changed");
    expect(result.combined).toEqual(["pending", "failure"]);
  });

  it("settles after CI completes without leaving either evaluation failed", () => {
    const waiting = evaluate({
      [runsPath]: { total_count: 1, workflow_runs: [{ ...run, status: "in_progress" }] },
      [`GET ${actions}/runs/10`]: { ...run, status: "in_progress" },
    });
    const completed = evaluate();
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.combined.at(-1)).toBe("pending");
    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.combined.at(-1)).toBe("success");
  });

  it.each([
    { name: "CI API failure", routes: { [runsPath]: { httpError: 403 } } },
    { name: "invalid CI metadata", routes: { [runsPath]: { workflow_runs: null } } },
    { name: "invalid job list", routes: { [jobsPath]: { jobs: null } } },
    {
      name: "status publication failure",
      routes: { [`POST /repos/openclaw/openclaw/statuses/${head}`]: { httpError: 403 } },
    },
  ])("fails the job and keeps the gate closed for $name", ({ routes }) => {
    const result = evaluate(routes);
    expect(result.status).toBe(1);
    expect(result.combined).not.toContain("success");
    expect(result.stderr).not.toBe("");
  });

  it.each(["src/gateway/auth.ts", "pnpm-workspace.yaml"])(
    "keeps the combined gate closed when only %s requires approval",
    (filename) => {
      const result = evaluate({
        [rolePath]: { role_name: "write" },
        [`GET ${pullPath}`]: { ...pr, changed_files: 1 },
        [`GET ${pullPath}/files`]: [{ filename, status: "modified" }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.combined.at(-1)).toBe("failure");
      expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(1);
    },
  );

  it("does not hide a guard error when the other guard awaits approval", () => {
    const result = evaluate({
      [rolePath]: { responses: [{ httpError: 403 }, { role_name: "write" }] },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fixture API failure");
    expect(result.combined).not.toContain("success");
    expect(
      result.requests.some((entry) =>
        entry.body?.body?.includes("/allow-security-sensitive-change"),
      ),
    ).toBe(true);
  });

  it("preserves a guard error when the sibling observes a superseded head", () => {
    const result = evaluate({
      [rolePath]: { httpError: 403 },
      [`GET ${pullPath}`]: {
        responses: [pr, pr, { ...pr, head: { ...pr.head, sha: "d".repeat(40) } }],
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fixture API failure");
    expect(result.combined.at(-1)).toBe("failure");
    expect(result.reviews.some((entry) => entry.body?.state === "success")).toBe(false);
  });

  it("publishes both review notices and settles automatically after command approval", () => {
    const result = evaluate({ [rolePath]: { role_name: "write" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "failure"]);
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
    expect(approved.status, approved.stderr).toBe(0);
    expect(approved.combined.at(-1)).toBe("success");
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("approval changed");
    expect(result.combined).not.toContain("success");
  });

  it("ignores main advancement and absent-to-null metadata during evaluation", () => {
    const result = evaluate({
      [`GET ${pullPath}`]: {
        responses: [
          pr,
          { ...pr, base: { ...pr.base, sha: "e".repeat(40) }, maintainer_can_modify: null },
        ],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "success"]);
    expect(result.reviews.filter((entry) => entry.body?.state === "success")).toHaveLength(2);
  });

  it.each([
    {
      name: "head",
      changedPr: { ...pr, head: { ...pr.head, sha: "d".repeat(40) } },
      changedFields: [],
    },
    {
      name: "target branch",
      changedPr: { ...pr, base: { ...pr.base, ref: "stable" } },
      changedFields: ["base.ref"],
    },
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
      [`GET ${pullPath}`]: {
        responses: [pr, pr, pr, pr, pr, changedPr],
      },
    });
    const superseded = changedFields.length === 0;
    expect(result.status).toBe(superseded ? 0 : 1);
    expect(result.combined).not.toContain("success");
    if (superseded) {
      expect(result.stdout).toContain("Superseded");
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

  it("grandfathers an old branch without issuing reusable standalone successes or notices", () => {
    const result = evaluate(exemptRoutes);
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "success"]);
    expect(result.reviews).toEqual([]);
    expect(result.requests.some((entry) => entry.path.includes("/issues/"))).toBe(false);
    expect(result.requests.some((entry) => entry.path.endsWith("/files"))).toBe(false);
  });

  it("still requires real CI for a grandfathered PR", () => {
    const result = evaluate({ ...exemptRoutes, [runsPath]: { total_count: 0, workflow_runs: [] } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.combined).toEqual(["pending", "pending"]);
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.reviews.filter((entry) => entry.body?.state === "failure")).toHaveLength(4);
    expect(result.combined).not.toContain("success");
  });

  it("leaves the combined gate failed when rollout metadata cannot be read", () => {
    const result = evaluate({ "GET /repos/openclaw/openclaw/pulls/152415": { httpError: 403 } });
    expect(result.status).toBe(1);
    expect(result.combined).toEqual(["pending", "failure"]);
    expect(result.reviews).toEqual([]);
  });
});
