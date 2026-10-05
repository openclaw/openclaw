import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const prefix = "/repos/openclaw/openclaw";
const repository = { full_name: "openclaw/openclaw", default_branch: "main" };
const pullRequest = {
  number: 42,
  state: "open",
  draft: false,
  base: { ref: "main", repo: repository },
  head: { sha: head, ref: "feature", repo: { id: 99 } },
};
const run = {
  id: 123,
  workflow_id: 456,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  repository,
  head_sha: head,
  head_branch: "feature",
  head_repository: { id: 99, owner: { login: "contributor" } },
  pull_requests: [{ number: 42 }],
};
const scheduledRunsPath = `${prefix}/actions/workflows/security-review.yml/runs?event=schedule&status=success&per_page=1`;
const ciRunsPath = `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&created=2026-01-01T20%3A00%3A00.000Z..2026-01-02T00%3A00%3A00.000Z&per_page=100&page=1`;
const completedRun = {
  ...run,
  created_at: "2026-01-01T22:30:00Z",
  updated_at: "2026-01-01T23:40:00Z",
};
function recordedPullRequest(number: number) {
  return {
    context: "openclaw/ci-gate",
    description: `PR #${number}: Checking security review`,
    state: "pending",
    creator: { login: "github-actions[bot]", type: "Bot" },
  };
}

type Reply = { body: unknown; status?: number; headers?: Record<string, string> };
type Options = {
  eventName?: string;
  event?: Record<string, unknown>;
  run?: Record<string, unknown>;
  pullRequest?: Record<string, unknown>;
  responses?: Record<string, Reply | Reply[]>;
};

function evaluate(options: Options = {}) {
  const root = tempDirs.make("security-review-event-");
  const eventFile = join(root, "event.json");
  const traceFile = join(root, "requests.jsonl");
  const outputFile = join(root, "output");
  const responses = {
    [`${prefix}/actions/runs/123`]: { body: { ...run, ...options.run } },
    [`${prefix}/actions/workflows/ci.yml`]: { body: { id: 456, path: run.path } },
    [`${prefix}/pulls/42`]: { body: { ...pullRequest, ...options.pullRequest } },
    [`${prefix}/commits/${head}/pulls?per_page=100&page=1`]: { body: [{ number: 42 }] },
    [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: {
      body:
        options.eventName === "schedule"
          ? [
              {
                ...recordedPullRequest(42),
                description: "PR #42: Waiting for CI; review updates automatically",
                created_at: "2026-01-01T23:30:00Z",
              },
            ]
          : [],
    },
    [scheduledRunsPath]: { body: { workflow_runs: [] } },
    [ciRunsPath]: {
      body: { total_count: 1, workflow_runs: [{ ...completedRun, ...options.run }] },
    },
    ...options.responses,
  };
  writeFileSync(
    eventFile,
    JSON.stringify({
      repository,
      action: "completed",
      workflow_run: { id: run.id, head_sha: head },
      ...options.event,
    }),
  );
  const preload = join(root, "fetch.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync, existsSync } from "node:fs";
import { installGuardClock } from ${JSON.stringify(resolve("test/fixtures/github-guard-clock.mjs"))};
installGuardClock(${JSON.stringify(traceFile)});
const responses = ${JSON.stringify(responses)};
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search;
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
    path, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : undefined,
    hadOutput: existsSync(${JSON.stringify(outputFile)}),
  }) + "\\n");
  if (parsed.origin !== "https://api.github.com") throw new Error("Unexpected API origin");
  const route = responses[path] ?? (
    options.method === "POST" && path.startsWith(${JSON.stringify(`${prefix}/statuses/`)})
      ? { body: {} }
      : undefined
  );
  const reply = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
  if (!reply) throw new Error("Unexpected API request: " + path);
  return new Response(JSON.stringify(reply.body), {status: reply.status ?? 200, headers: reply.headers});
};
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preload, resolve("scripts/github/security-review-event.mjs")],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_EVENT_NAME: options.eventName ?? "workflow_run",
        GITHUB_OUTPUT: outputFile,
        GITHUB_RUN_ID: "789",
      },
    },
  );
  const trace = existsSync(traceFile)
    ? readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              path: string;
              delay?: number;
              method: string;
              body?: { context: string; state: string; description: string; target_url: string };
              hadOutput: boolean;
            },
        )
    : [];
  return {
    status: result.status,
    error: result.stderr.trim(),
    matrix:
      result.status === 0
        ? (JSON.parse(result.stdout) as { include: { pr: number; head: string }[] })
        : undefined,
    output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
    waits: trace.filter(({ method }) => method === "WAIT").map(({ delay }) => delay!),
    requests: trace.map(({ path, method }) => ({ path, method })),
    published: trace.filter(({ method }) => method === "POST"),
  };
}

function reconcileStatuses(statuses: unknown[]) {
  return evaluate({
    eventName: "schedule",
    responses: {
      [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: { body: statuses },
    },
  });
}

describe("automatic security review event resolution", () => {
  it("automatically resolves the current PR after a rate-limited lookup", () => {
    const result = evaluate({
      eventName: "pull_request_target",
      event: { action: "opened", pull_request: { number: 42 } },
      responses: {
        [`${prefix}/pulls/42`]: [
          {
            body: { message: "API rate limit exceeded for installation" },
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767315600" },
          },
          { body: pullRequest },
        ],
      },
    });
    expect(result.status, result.error).toBe(0);
    expect(result.waits).toHaveLength(1);
    expect(result.waits[0]).toBeGreaterThanOrEqual(3_600_000);
    expect(result.matrix).toEqual({ include: [{ pr: 42, head }] });
    expect(result.published).toHaveLength(1);
    expect(result.requests.map(({ method }) => method)).toEqual(["GET", "WAIT", "GET", "POST"]);
  });

  it("resolves the fresh head after a failed pending status before scheduling review", () => {
    const nextHead = "b".repeat(40);
    const result = evaluate({
      eventName: "pull_request_target",
      event: { action: "opened", pull_request: { number: 42 } },
      responses: {
        [`${prefix}/pulls/42`]: [
          { body: pullRequest },
          { body: { ...pullRequest, head: { ...pullRequest.head, sha: nextHead } } },
        ],
        [`${prefix}/statuses/${head}`]: { status: 500, body: { message: "Server error" } },
      },
    });
    expect(result.status, result.error).toBe(0);
    expect(result.waits).toEqual([1_000]);
    expect(result.matrix).toEqual({ include: [{ pr: 42, head: nextHead }] });
    expect(result.published.map(({ path }) => path)).toEqual([
      `${prefix}/statuses/${head}`,
      `${prefix}/statuses/${nextHead}`,
    ]);
    expect(result.published.every(({ hadOutput }) => !hadOutput)).toBe(true);
    expect(result.published.at(-1)?.body?.state).toBe("pending");
    expect(result.output).toBe(
      `matrix={"include":[{"pr":42,"head":"${nextHead}"}]}\nhas-prs=true\ntruncated=false\n`,
    );
  });

  it.each(["pull_request_target", "issue_comment"])(
    "resolves %s through current PR metadata",
    (eventName) => {
      const result = evaluate({
        eventName,
        event: {
          action: "created",
          pull_request: { number: 42 },
          issue: { number: 42, pull_request: {} },
          comment: { body: "/allow-dependencies-change" },
        },
      });
      expect(result).toMatchObject({
        status: 0,
        matrix: { include: [{ pr: 42, head }] },
        error: "",
      });
      expect(result.output).toBe(
        `matrix={"include":[{"pr":42,"head":"${head}"}]}\nhas-prs=true\ntruncated=false\n`,
      );
      expect(result.requests).toEqual([
        { path: `${prefix}/pulls/42`, method: "GET" },
        { path: `${prefix}/statuses/${head}`, method: "POST" },
      ]);
      expect(result.published).toMatchObject([
        {
          path: `${prefix}/statuses/${head}`,
          hadOutput: false,
          body: {
            context: "openclaw/ci-gate",
            state: "pending",
            description: "PR #42: Review scheduled; CI and security review have not completed",
            target_url: "https://github.com/openclaw/openclaw/actions/runs/789",
          },
        },
      ]);
    },
  );

  it("does not schedule a review job when its initial pending status cannot be recorded", () => {
    const result = evaluate({
      eventName: "pull_request_target",
      event: { action: "opened", pull_request: { number: 42 } },
      responses: {
        [`${prefix}/statuses/${head}`]: { status: 403, body: { message: "Forbidden" } },
      },
    });
    expect(result).toMatchObject({ status: 1, output: "" });
    expect(result.waits).toEqual([]);
    expect(result.published).toHaveLength(1);
    expect(result.published[0]?.hadOutput).toBe(false);
  });

  it.each([
    { action: "closed", changedPull: { state: "closed" } },
    { action: "edited", changedPull: { base: { ref: "release/1", repo: repository } } },
  ])("refreshes the remaining PR after a duplicate is $action", ({ action, changedPull }) => {
    const result = evaluate({
      eventName: "pull_request_target",
      event: { action, pull_request: { number: 42 } },
      pullRequest: changedPull,
      responses: {
        [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: {
          body: [recordedPullRequest(42), recordedPullRequest(43)],
        },
        [`${prefix}/pulls/43`]: { body: { ...pullRequest, number: 43 } },
      },
    });
    expect(result).toMatchObject({ status: 0, matrix: { include: [{ pr: 43, head }] } });
    expect(result.requests.map((request) => request.path)).toEqual([
      `${prefix}/pulls/42`,
      `${prefix}/commits/${head}/statuses?per_page=100&page=1`,
      `${prefix}/pulls/43`,
      `${prefix}/statuses/${head}`,
    ]);
  });

  it("refreshes both the changed PR and PRs remaining on its previous head after a push", () => {
    const nextHead = "b".repeat(40);
    const result = evaluate({
      eventName: "pull_request_target",
      event: { action: "synchronize", before: head, pull_request: { number: 42 } },
      pullRequest: { head: { ...pullRequest.head, sha: nextHead } },
      responses: {
        [`${prefix}/commits/${nextHead}/statuses?per_page=100&page=1`]: { body: [] },
        [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: {
          body: [recordedPullRequest(42), recordedPullRequest(43), recordedPullRequest(44)],
        },
        [`${prefix}/pulls/43`]: { body: { ...pullRequest, number: 43 } },
        [`${prefix}/pulls/44`]: {
          body: { ...pullRequest, number: 44, head: { ...pullRequest.head, sha: "c".repeat(40) } },
        },
      },
    });
    expect(result).toMatchObject({
      status: 0,
      matrix: {
        include: [
          { pr: 42, head: nextHead },
          { pr: 43, head },
        ],
      },
    });
    expect(
      result.published.map((entry) => ({
        path: entry.path,
        description: entry.body?.description,
        state: entry.body?.state,
        hadOutput: entry.hadOutput,
      })),
    ).toEqual([
      {
        path: `${prefix}/statuses/${nextHead}`,
        description: "PR #42: Review scheduled; CI and security review have not completed",
        state: "pending",
        hadOutput: false,
      },
      {
        path: `${prefix}/statuses/${head}`,
        description: "PR #43: Review scheduled; CI and security review have not completed",
        state: "pending",
        hadOutput: false,
      },
    ]);
    expect(result.requests.filter((request) => request.path.includes("/commits/"))).toEqual([
      { path: `${prefix}/commits/${nextHead}/statuses?per_page=100&page=1`, method: "GET" },
      { path: `${prefix}/commits/${head}/statuses?per_page=100&page=1`, method: "GET" },
    ]);
  });

  it("does not use forged or unrelated status descriptions as recorded PR identities", () => {
    const result = evaluate({
      eventName: "pull_request_target",
      event: { action: "closed", pull_request: { number: 42 } },
      pullRequest: { state: "closed" },
      responses: {
        [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: {
          body: [
            { ...recordedPullRequest(98), creator: { type: "User", login: "contributor" } },
            { ...recordedPullRequest(99), context: "unrelated/status" },
          ],
        },
      },
    });
    expect(result).toMatchObject({ status: 0, matrix: { include: [] } });
    expect(result.requests).toHaveLength(2);
  });

  it.each([
    {
      name: "recorded PR identities",
      options: {
        eventName: "pull_request_target",
        event: { action: "closed", pull_request: { number: 42 } },
        pullRequest: { state: "closed" },
      },
      route: `${prefix}/commits/${head}/statuses?per_page=100&page=1`,
    },
    {
      name: "commit associations",
      options: { run: { pull_requests: [] } },
      route: `${prefix}/commits/${head}/pulls?per_page=100&page=1`,
    },
  ])("fails closed when $name cannot be read", ({ options, route }) => {
    const result = evaluate({
      ...options,
      responses: { [route]: { status: 403, body: { message: "Forbidden" } } },
    });
    expect(result).toMatchObject({ status: 1, output: "" });
    expect(result.requests.at(-1)?.path).toBe(route);
  });

  it.each<{
    action: string;
    body: string | null;
    previousBody?: string;
    issueOnly?: boolean;
    selected: boolean;
  }>([
    ...[
      {
        action: "created",
        body: " \r\n /allow-dependencies-change \r\n/allow-security-sensitive-change\n",
      },
      { action: "edited", body: "Removed", previousBody: "/allow-dependencies-change" },
      { action: "edited", body: "/allow-dependencies-change", previousBody: "Thanks" },
      { action: "deleted", body: "/allow-security-sensitive-change" },
    ].map(({ action, body, previousBody }) => ({ action, body, previousBody, selected: true })),
    ...[
      { action: "created", body: "Thanks" },
      { action: "deleted", body: "Thanks" },
      { action: "created", body: "/allow-dependencies-change-extra" },
      { action: "created", body: "/allow-dependencies-change\nThanks" },
      { action: "edited", body: "Removed", previousBody: "Please post /allow-dependencies-change" },
      { action: "created", body: "/ALLOW-DEPENDENCIES-CHANGE" },
      { action: "created", body: " \r\n " },
      { action: "deleted", body: null },
      { action: "created", body: "/allow-security-sensitive-change", issueOnly: true },
    ].map(({ action, body, previousBody, issueOnly }) => ({
      action,
      body,
      previousBody,
      issueOnly,
      selected: false,
    })),
  ])(
    "selects only approval command activity: %j",
    ({ action, body, previousBody, issueOnly, selected }) => {
      const result = evaluate({
        eventName: "issue_comment",
        event: {
          action,
          issue: { number: 42, ...(issueOnly ? {} : { pull_request: {} }) },
          comment: { body },
          changes: { body: { from: previousBody } },
        },
      });
      expect(result).toMatchObject({
        status: 0,
        matrix: { include: selected ? [{ pr: 42, head }] : [] },
      });
      if (selected) {
        expect(result.published).toMatchObject([
          { body: { context: "openclaw/ci-gate", state: "pending" } },
        ]);
      } else {
        expect(result.requests).toEqual([]);
      }
    },
  );

  it("rejects manual dispatch before making any API request", () => {
    const result = evaluate({
      eventName: "workflow_dispatch",
      event: { inputs: { pr_number: "42" } },
    });
    expect(result).toMatchObject({
      status: 1,
      error: "Security review requires an automatic pull request or CI event.",
      output: "",
      requests: [],
    });
  });

  it.each([
    { name: "successful CI", changedRun: { conclusion: "success" }, associated: false },
    { name: "failed CI", changedRun: { conclusion: "failure" }, associated: false },
    {
      name: "release fallback",
      changedRun: { event: "workflow_dispatch", display_title: `CI release gate ${head}` },
      associated: false,
    },
    { name: "fork association", changedRun: { pull_requests: [] }, associated: true },
  ])("reevaluates $name against the live head", ({ changedRun, associated }) => {
    const result = evaluate({ run: changedRun });
    expect(result).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
    expect(result.requests.map((request) => request.path)).toEqual([
      `${prefix}/actions/runs/123`,
      `${prefix}/actions/workflows/ci.yml`,
      ...(associated ? [`${prefix}/commits/${head}/pulls?per_page=100&page=1`] : []),
      `${prefix}/pulls/42`,
      `${prefix}/statuses/${head}`,
    ]);
    expect(result.requests.slice(0, -1).every((request) => request.method === "GET")).toBe(true);
    expect(result.published).toHaveLength(1);
    expect(result.published[0]?.body?.state).toBe("pending");
  });

  it.each<Options>([
    ...["CI", `CI release gate ${"b".repeat(40)}`].map((display_title) => ({
      run: { event: "workflow_dispatch", display_title },
    })),
    ...[
      { draft: true },
      { state: "closed" },
      { base: { ref: "release/1", repo: repository } },
      { head: { ...pullRequest.head, sha: "b".repeat(40) } },
      { head: { ...pullRequest.head, repo: { id: 100 } } },
    ].map((value) => ({ pullRequest: value })),
  ])("does not retarget unrelated CI or PR states: %j", (options) => {
    expect(evaluate(options)).toMatchObject({ status: 0, matrix: { include: [] } });
  });

  it.each([
    { workflow_id: 789 },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "other/repository" } },
    { head_sha: "b".repeat(40) },
  ])("refuses a CI event whose live identity changed: %j", (changedRun) => {
    const result = evaluate({ run: changedRun });
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
    expect(result.requests).not.toContainEqual({ path: `${prefix}/pulls/42`, method: "GET" });
  });

  it.each([200, 404, 422])(
    "falls back to the exact fork branch when commit association returns %s",
    (status) => {
      const result = evaluate({
        run: { pull_requests: [] },
        responses: {
          [`${prefix}/commits/${head}/pulls?per_page=100&page=1`]: {
            status,
            body: status === 200 ? [] : { message: "Commit unavailable" },
          },
          [`${prefix}/pulls?state=open&head=contributor%3Afeature&per_page=100&page=1`]: {
            body: [{ number: 42 }],
          },
        },
      });
      expect(result).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
      expect(
        result.requests.some((request) => request.path === `${prefix}/pulls?per_page=100&page=1`),
      ).toBe(false);
    },
  );
});

describe("scheduled reconciliation", () => {
  it("covers the previous pass's grace period without reading older head statuses", () => {
    const olderHead = "b".repeat(40);
    const result = evaluate({
      eventName: "schedule",
      responses: {
        [scheduledRunsPath]: {
          body: { workflow_runs: [{ created_at: "2026-01-01T23:45:00Z" }] },
        },
        [ciRunsPath.replace("20%3A00", "20%3A40")]: {
          body: {
            total_count: 2,
            workflow_runs: [
              { ...completedRun, updated_at: "2026-01-01T23:43:00Z" },
              { ...completedRun, id: 122, head_sha: olderHead, updated_at: "2026-01-01T23:39:00Z" },
            ],
          },
        },
      },
    });
    expect(result.status, result.error).toBe(0);
    expect(result.matrix).toEqual({ include: [{ pr: 42, head }] });
    expect(result.requests.filter(({ path }) => path.includes("/statuses?"))).toEqual([
      { path: `${prefix}/commits/${head}/statuses?per_page=100&page=1`, method: "GET" },
    ]);
  });

  it.each([
    {
      name: "stale success",
      statuses: [
        { ...recordedPullRequest(42), state: "success", created_at: "2026-01-01T23:30:00Z" },
      ],
    },
    {
      name: "pending after completion",
      statuses: [
        {
          ...recordedPullRequest(42),
          state: "pending",
          created_at: "2026-01-01T23:41:00Z",
          description: "PR #42: Review scheduled; CI and security review have not completed",
        },
      ],
    },
    { name: "missing gate", statuses: [{ context: "unrelated/status", state: "success" }] },
    {
      name: "foreign successes",
      statuses: [
        {
          ...recordedPullRequest(42),
          state: "success",
          created_at: "2026-01-01T23:45:00Z",
          creator: { login: "foreign-bot[bot]", type: "Bot" },
        },
        {
          ...recordedPullRequest(42),
          state: "success",
          created_at: "2026-01-01T23:44:00Z",
          creator: { login: "github-actions[bot]", type: "User" },
        },
        { ...recordedPullRequest(42), state: "pending", created_at: "2026-01-01T23:41:00Z" },
        { ...recordedPullRequest(42), state: "success", created_at: "2026-01-01T23:20:00Z" },
      ],
    },
  ])("schedules $name before publishing its matrix", ({ statuses }) => {
    const result = reconcileStatuses(statuses);
    expect(result.status, result.error).toBe(0);
    expect(result.matrix).toEqual({ include: [{ pr: 42, head }] });
    expect(result.output).toBe(
      `matrix={"include":[{"pr":42,"head":"${head}"}]}\nhas-prs=true\ntruncated=false\n`,
    );
    expect(result.published).toHaveLength(1);
    expect(result.published).toMatchObject([
      {
        path: `${prefix}/statuses/${head}`,
        hadOutput: false,
        body: {
          context: "openclaw/ci-gate",
          state: "pending",
          description: "PR #42: Review scheduled; CI and security review have not completed",
        },
      },
    ]);
    expect(result.requests).toContainEqual({ path: ciRunsPath, method: "GET" });
    expect(result.requests.find(({ path }) => path.includes("created="))?.path).toContain(
      "..2026-01-02T00%3A00%3A00.000Z",
    );
  });

  it.each([
    ...["2026-01-01T23:00:00Z", "2026-01-01T23:55:00Z"].map((updated_at) => ({
      changedRun: { updated_at },
      selected: true,
    })),
    ...[
      { updated_at: "2026-01-01T23:56:00Z" },
      { updated_at: "2026-01-01T22:59:59Z" },
      { conclusion: "skipped" },
      { status: "in_progress" },
    ].map((changedRun) => ({ changedRun, selected: false })),
  ])(
    "selects substantive CI inside the inclusive completion window: $changedRun",
    ({ changedRun, selected }) => {
      const result = evaluate({
        eventName: "schedule",
        run: changedRun,
        responses: { [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: { body: [] } },
      });
      expect(result).toMatchObject({
        status: 0,
        matrix: { include: selected ? [{ pr: 42, head }] : [] },
      });
      if (!selected) {
        expect(result.published).toEqual([]);
        expect(result.requests).toEqual([
          { path: scheduledRunsPath, method: "GET" },
          { path: ciRunsPath, method: "GET" },
        ]);
      }
    },
  );

  it.each([
    ...["2026-01-01T23:41:00Z", completedRun.updated_at].map((created_at) => ({
      name: `settled ${created_at}`,
      statuses: [
        { ...recordedPullRequest(42), context: "OpenClaw/CI-Gate", state: "success", created_at },
      ],
      paged: false,
      selected: false,
    })),
    {
      name: "paginated settled gate",
      statuses: [
        { ...recordedPullRequest(42), state: "success", created_at: completedRun.updated_at },
      ],
      paged: true,
      selected: false,
    },
    { name: "paginated missing gate", statuses: [], paged: true, selected: true },
  ])("reads the newest owned result for $name", ({ statuses, paged, selected }) => {
    const statusPath = `${prefix}/commits/${head}/statuses?per_page=100&page=`;
    const result = evaluate({
      eventName: "schedule",
      responses: {
        [statusPath + "1"]: {
          body: paged
            ? Array.from({ length: 100 }, () => ({
                ...recordedPullRequest(42),
                state: "success",
                created_at: "2026-01-01T23:45:00Z",
                creator: { login: "foreign-bot[bot]", type: "Bot" },
              }))
            : statuses,
        },
        ...(paged ? { [statusPath + "2"]: { body: statuses } } : {}),
      },
    });
    expect(result.status, result.error).toBe(0);
    expect(result.matrix).toEqual({ include: selected ? [{ pr: 42, head }] : [] });
    expect(result.published).toHaveLength(selected ? 1 : 0);
    if (!selected) {
      expect(result.requests.some(({ path }) => path.includes("/pulls/"))).toBe(false);
    }
    expect(result.requests.filter(({ path }) => path.includes("/statuses?"))).toEqual(
      (paged ? [1, 2] : [1]).map((page) => ({ path: statusPath + page, method: "GET" })),
    );
  });

  it("dedupes reruns by the highest run id before reading the head status", () => {
    const result = evaluate({
      eventName: "schedule",
      responses: {
        [ciRunsPath]: {
          body: {
            total_count: 2,
            workflow_runs: [
              { ...completedRun, id: 124 },
              { ...completedRun, updated_at: "2026-01-01T23:20:00Z" },
            ],
          },
        },
      },
    });
    expect(result).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
    expect(result.requests.filter(({ path }) => path.includes("/statuses?"))).toEqual([
      { path: `${prefix}/commits/${head}/statuses?per_page=100&page=1`, method: "GET" },
    ]);
    expect(result.published).toHaveLength(1);
  });

  it("bisects a 1500-run creation range and fully pages both inclusive slices", () => {
    const firstSlice = ciRunsPath.replace("2026-01-02T00%3A00", "2026-01-01T22%3A00");
    const secondSlice = ciRunsPath.replace("2026-01-01T20%3A00%3A00", "2026-01-01T22%3A00%3A01");
    const responses: Record<string, Reply> = {
      [ciRunsPath]: { body: { total_count: 1500, workflow_runs: [completedRun] } },
    };
    const listingPaths = [ciRunsPath];
    for (const [slice, count, offset] of [
      [firstSlice, 800, 0],
      [secondSlice, 700, 800],
    ] as const) {
      for (let page = 1; page <= count / 100 + 1; page += 1) {
        const path = slice.replace(/&page=1$/u, `&page=${page}`);
        listingPaths.push(path);
        responses[path] = {
          body: {
            total_count: count,
            workflow_runs: Array.from({ length: page <= count / 100 ? 100 : 0 }, (_, index) => ({
              ...completedRun,
              id: offset + (page - 1) * 100 + index + 1,
              created_at: offset === 0 ? "2026-01-01T21:00:00Z" : "2026-01-01T23:00:00Z",
            })),
          },
        };
      }
    }
    const result = evaluate({ eventName: "schedule", responses });
    expect(result.status, result.error).toBe(0);
    expect(result.requests.filter(({ path }) => path.includes("/workflows/ci.yml/runs"))).toEqual(
      listingPaths.map((path) => ({ path, method: "GET" })),
    );
    expect(result.matrix).toEqual({ include: [{ pr: 42, head }] });
    expect(result.published).toHaveLength(1);
  });

  it.each([
    { total: 0, sizes: [0], complete: true },
    { total: 200, sizes: [100, 100, 0], complete: true },
    { total: 201, sizes: [100, 100, 1], complete: true },
    { total: 201, sizes: [100, 100, 0], complete: false },
    { total: 150, sizes: [100, 100, 5], complete: true },
    { total: 150, sizes: Array.from({ length: 10 }, () => 100), complete: false },
  ])(
    "pages until short for total $total, sizes $sizes, complete $complete",
    ({ total, sizes, complete }) => {
      const responses: Record<string, Reply> = {};
      const listingPaths = sizes.map((size, index) => {
        const path = ciRunsPath.replace(/&page=1$/u, `&page=${index + 1}`);
        responses[path] = {
          body: {
            total_count: total,
            workflow_runs: Array.from({ length: size }, (_, runIndex) => ({
              ...completedRun,
              id: index * 100 + runIndex + 1,
            })),
          },
        };
        return path;
      });
      const result = evaluate({ eventName: "schedule", responses });
      expect(result.requests.filter(({ path }) => path.includes("/workflows/ci.yml/runs"))).toEqual(
        listingPaths.map((path) => ({ path, method: "GET" })),
      );
      if (!complete) {
        expect(result).toMatchObject({ status: 1, output: "", published: [] });
        expect(result.error).toContain("covered window does not advance");
        expect(result.matrix).toBeUndefined();
        return;
      }
      expect(result.status, result.error).toBe(0);
      expect(result.matrix).toEqual({ include: total === 0 ? [] : [{ pr: 42, head }] });
      expect(result.requests.filter(({ path }) => path.includes("/statuses?"))).toHaveLength(
        total === 0 ? 0 : 1,
      );
      expect(result.published).toHaveLength(total === 0 ? 0 : 1);
      expect(result.output).toContain("truncated=false\n");
    },
  );

  it("fails an overfull sub-ten-minute slice before status publication or matrix output", () => {
    const ends = [
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T22:00:00.000Z",
      "2026-01-01T21:00:00.000Z",
      "2026-01-01T20:30:00.000Z",
      "2026-01-01T20:15:00.000Z",
      "2026-01-01T20:07:30.000Z",
    ];
    const listingPaths = ends.map(
      (end) =>
        `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&created=${encodeURIComponent(`2026-01-01T20:00:00.000Z..${end}`)}&per_page=100&page=1`,
    );
    const result = evaluate({
      eventName: "schedule",
      responses: Object.fromEntries(
        listingPaths.map((path) => [
          path,
          {
            body: { total_count: 1001, workflow_runs: [completedRun] },
          },
        ]),
      ),
    });
    expect(result.status).toBe(1);
    expect(result.error).toContain(
      "more than 1000 runs in a creation range shorter than ten minutes",
    );
    expect(result.error).toContain("covered window does not advance");
    expect(result.requests).toEqual([
      { path: scheduledRunsPath, method: "GET" },
      ...listingPaths.map((path) => ({ path, method: "GET" })),
    ]);
    expect(result.matrix).toBeUndefined();
    expect(result.output).toBe("");
    expect(result.published).toEqual([]);
  });

  it.each([
    ...[undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((total_count) => ({
      total_count,
      workflow_runs: [completedRun],
      error: "invalid total_count",
    })),
    {
      total_count: 2,
      workflow_runs: [completedRun, completedRun],
      error: "covered window does not advance",
    },
  ])(
    "rejects incomplete or invalid listing totals: $total_count",
    ({ total_count, workflow_runs, error }) => {
      const result = evaluate({
        eventName: "schedule",
        responses: { [ciRunsPath]: { body: { total_count, workflow_runs } } },
      });
      expect(result).toMatchObject({ status: 1, output: "", published: [] });
      expect(result.error).toContain(error);
    },
  );

  it.each([
    { previous: "2026-01-01T23:46:00Z", queryHour: "20%3A41", selected: false },
    { previous: "2026-01-01T10:00:00Z", queryHour: "09%3A00", selected: true },
    { previous: "invalid", queryHour: "20%3A00", selected: true },
  ])(
    "bounds the window from the previous successful pass: $previous",
    ({ previous, queryHour, selected }) => {
      const result = evaluate({
        eventName: "schedule",
        responses: {
          [scheduledRunsPath]: { body: { workflow_runs: [{ created_at: previous }] } },
          [ciRunsPath.replace("20%3A00", queryHour)]: {
            body: { total_count: 1, workflow_runs: [completedRun] },
          },
        },
      });
      expect(result.status, result.error).toBe(0);
      expect(result.matrix).toEqual({ include: selected ? [{ pr: 42, head }] : [] });
      expect(result.requests.some(({ path }) => path.includes("/statuses?"))).toBe(selected);
    },
  );

  it.each([100, 101])("selects at most 100 of %s stale candidates, oldest first", (count) => {
    const candidates = Array.from({ length: count }, (_, index) => ({
      ...completedRun,
      id: index + 1,
      head_sha: (index + 1).toString(16).padStart(40, "0"),
      updated_at: new Date(
        Date.parse("2026-01-01T23:00:00Z") + Math.floor(index / 2) * 1000,
      ).toISOString(),
      pull_requests: [{ number: 1000 - index }],
    }));
    const responses: Record<string, Reply> = {};
    const newestFirst = candidates.toReversed();
    for (let page = 1; page <= Math.floor(count / 100) + 1; page += 1) {
      responses[ciRunsPath.replace(/&page=1$/u, `&page=${page}`)] = {
        body: {
          total_count: count,
          workflow_runs: newestFirst.slice((page - 1) * 100, page * 100),
        },
      };
    }
    for (const candidate of candidates) {
      responses[`${prefix}/commits/${candidate.head_sha}/statuses?per_page=100&page=1`] = {
        body: [],
      };
      responses[`${prefix}/pulls/${candidate.pull_requests[0]!.number}`] = {
        body: {
          ...pullRequest,
          number: candidate.pull_requests[0]!.number,
          head: { ...pullRequest.head, sha: candidate.head_sha },
        },
      };
    }
    const result = evaluate({ eventName: "schedule", responses });
    const selected = candidates.slice(0, 100);
    expect(result.status, result.error).toBe(0);
    expect(result.matrix).toEqual({
      include: selected.map((candidate) => ({
        pr: candidate.pull_requests[0]!.number,
        head: candidate.head_sha,
      })),
    });
    expect(result.requests.filter(({ path }) => path.includes("/statuses?"))).toEqual(
      selected.map((candidate) => ({
        path: `${prefix}/commits/${candidate.head_sha}/statuses?per_page=100&page=1`,
        method: "GET",
      })),
    );
    expect(result.published).toHaveLength(selected.length);
    expect(result.published.every(({ hadOutput }) => !hadOutput)).toBe(true);
    expect(result.output).toContain(`truncated=${count > 100}\n`);
  });

  it("uses the current PR head when multiple completed heads name the same PR", () => {
    const oldHead = "b".repeat(40);
    const result = evaluate({
      eventName: "schedule",
      responses: {
        [ciRunsPath]: {
          body: {
            total_count: 2,
            workflow_runs: [completedRun, { ...completedRun, id: 122, head_sha: oldHead }],
          },
        },
        [`${prefix}/commits/${oldHead}/statuses?per_page=100&page=1`]: { body: [] },
      },
    });
    expect(result).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
    expect(result.published).toHaveLength(1);
  });
});
