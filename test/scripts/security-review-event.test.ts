import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const prefix = "/repos/openclaw/openclaw";
const at = (time: string) => `2026-01-01T${time}:00Z`;
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
  run_attempt: 1,
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
  updated_at: at("23:40"),
};
const statusesPath = (sha = head, page = 1) =>
  `${prefix}/commits/${sha}/statuses?per_page=100&page=${page}`;
const pullPath = (number = 42) => `${prefix}/pulls/${number}`;
const publishPath = (sha = head) => `${prefix}/statuses/${sha}`;
const associationsPath = `${prefix}/commits/${head}/pulls?per_page=100&page=1`;
const branchPath = `${prefix}/pulls?state=open&head=contributor%3Afeature&per_page=100&page=1`;
const get = (path: string) => ({ path, method: "GET" });
const reply = (body: unknown) => ({ body });
const reviewEntry = (pr = 42, sha = head) => ({ pr, head: sha });
const completionEntry = (pr = 42, sha = head, ciRunId = 123, ciRunAttempt = 1) => ({
  ...reviewEntry(pr, sha),
  ciRunId,
  ciRunAttempt,
});
const creator = (login = "github-actions[bot]", type = "Bot") => ({ creator: { login, type } });
const changedPull = (number = 42, sha = head) => ({
  ...pullRequest,
  number,
  head: { ...pullRequest.head, sha },
});
const completed = (patch: Partial<typeof completedRun>) => ({ ...completedRun, ...patch });
function recordedPullRequest(number: number) {
  return {
    context: "openclaw/ci-gate",
    description: `PR #${number}: Checking security review`,
    state: "pending",
    ...creator(),
  };
}

function runListing(workflow_runs: object[], total_count = workflow_runs.length) {
  return { body: { total_count, workflow_runs } };
}

function listingPages(
  sizes: number[],
  total: number,
  path = ciRunsPath,
  makeRun: (index: number) => object = (index) => completed({ id: index + 1 }),
): Record<string, Reply> {
  return Object.fromEntries(
    sizes.map((size, index) => [
      path.replace(/&page=1$/u, `&page=${index + 1}`),
      runListing(
        Array.from({ length: size }, (_, row) => makeRun(index * 100 + row)),
        total,
      ),
    ]),
  );
}

const pageSizes = (count: number) =>
  Array.from({ length: Math.floor(count / 100) + 1 }, (_, page) =>
    Math.min(100, count - page * 100),
  );

function gateStatus(state: string, created_at: string, patch: object = {}) {
  return { ...recordedPullRequest(42), state, created_at, ...patch };
}
const settledGate = (created_at: string) =>
  gateStatus("success", created_at, { context: "OpenClaw/CI-Gate" });

type Reply = { body: unknown; status?: number; headers?: Record<string, string> };
type Trace = {
  path: string;
  delay?: number;
  method: string;
  body?: { context: string; state: string; description: string; target_url: string };
  hadOutput: boolean;
};
type Options = {
  eventName?: string;
  event?: Record<string, unknown>;
  run?: Record<string, unknown>;
  pullRequest?: Record<string, unknown>;
  responses?: Record<string, Reply | Reply[]>;
  expected?: Expected;
};
type Selection = { pr: number; head: string; ciRunId?: number; ciRunAttempt?: number }[];
type Expected = { status?: number; include?: Selection; posts?: number; truncated?: boolean };

function evaluate(options: Options = {}) {
  const expected = options.expected ?? {};
  const root = tempDirs.make("security-review-event-");
  const eventFile = join(root, "event.json");
  const traceFile = join(root, "requests.jsonl");
  const outputFile = join(root, "output");
  const responses = {
    [`${prefix}/actions/runs/123`]: { body: { ...run, ...options.run } },
    [`${prefix}/actions/workflows/ci.yml`]: { body: { id: 456, path: run.path } },
    [pullPath()]: reply({ ...pullRequest, ...options.pullRequest }),
    [associationsPath]: reply([{ number: 42 }]),
    [branchPath]: reply([]),
    [statusesPath()]: reply(
      options.eventName === "schedule" ? [gateStatus("pending", at("23:30"))] : [],
    ),
    [scheduledRunsPath]: reply({ workflow_runs: [] }),
    [ciRunsPath]: runListing([{ ...completedRun, ...options.run }]),
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
        .map((line) => JSON.parse(line) as Trace)
    : [];
  const requests = trace.map(({ path, method }) => ({ path, method }));
  const evaluated = {
    status: result.status,
    error: result.stderr.trim(),
    matrix:
      result.status === 0
        ? (JSON.parse(result.stdout) as { include: { pr: number; head: string }[] })
        : undefined,
    output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
    waits: trace.filter(({ method }) => method === "WAIT").map(({ delay }) => delay!),
    requests,
    paths: requests.map(({ path }) => path),
    published: trace.filter(({ method }) => method === "POST"),
    statusRequests: requests.filter(({ path }) => path?.includes("/statuses?")),
    listingRequests: requests.filter(({ path }) => path?.includes("/workflows/ci.yml/runs")),
  };
  expect(evaluated.status, evaluated.error).toBe(expected.status ?? 0);
  const include = expected.include ?? [
    ["pull_request_target", "issue_comment"].includes(options.eventName ?? "workflow_run") ||
    options.run?.conclusion === "skipped"
      ? reviewEntry()
      : completionEntry(
          42,
          head,
          Number(options.run?.id ?? 123),
          Number(options.run?.run_attempt ?? 1),
        ),
  ];
  expect(evaluated.published).toHaveLength(
    expected.posts ?? (evaluated.status === 0 ? include.length : 0),
  );
  expect(evaluated.published.every(({ hadOutput }) => !hadOutput)).toBe(true);
  if (evaluated.status === 0) {
    expect(evaluated.matrix).toEqual({ include });
    expect(evaluated.output).toBe(
      `matrix=${JSON.stringify({ include })}\nhas-prs=${include.length > 0}\ntruncated=${expected.truncated ?? false}\n`,
    );
    if (include.length) {
      expect(evaluated.published.slice(-include.length)).toMatchObject(
        include.map(({ pr, head: sha }) => pendingPublication(pr, sha)),
      );
    }
  } else {
    expect(evaluated).toMatchObject({ output: "", matrix: undefined });
  }
  return evaluated;
}

function scheduled(responses: NonNullable<Options["responses"]>, expected?: Expected) {
  return evaluate({ eventName: "schedule", responses, expected });
}

function pullEvent(options: Options & { action?: string } = {}) {
  return evaluate({
    ...options,
    eventName: "pull_request_target",
    event: { action: options.action ?? "opened", pull_request: { number: 42 }, ...options.event },
  });
}

function pendingPublication(pr = 42, sha = head) {
  return {
    path: publishPath(sha),
    hadOutput: false,
    body: {
      context: "openclaw/ci-gate",
      description: `PR #${pr}: Review scheduled; CI and security review have not completed`,
      state: "pending",
    },
  };
}

function statusCase(name: string, statuses: unknown[], selected = true, paged = false) {
  return { name, statuses, selected, paged };
}

describe("automatic security review event resolution", () => {
  it("automatically resolves the current PR after a rate-limited lookup", () => {
    const result = pullEvent({
      responses: {
        [pullPath()]: [
          {
            body: { message: "API rate limit exceeded for installation" },
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767315600" },
          },
          reply(pullRequest),
        ],
      },
    });
    expect(result.waits).toHaveLength(1);
    expect(result.waits[0]).toBeGreaterThanOrEqual(3_600_000);
    expect(result.requests.map(({ method }) => method)).toEqual(["GET", "WAIT", "GET", "POST"]);
  });

  it("resolves the fresh head after a failed pending status before scheduling review", () => {
    const nextHead = otherHead;
    const result = pullEvent({
      expected: { include: [reviewEntry(42, nextHead)], posts: 2 },
      responses: {
        [pullPath()]: [reply(pullRequest), reply(changedPull(42, nextHead))],
        [publishPath()]: { status: 500, body: { message: "Server error" } },
      },
    });
    expect(result.waits).toEqual([1_000]);
    expect(result.published.map(({ path }) => path)).toEqual([
      `${prefix}/statuses/${head}`,
      `${prefix}/statuses/${nextHead}`,
    ]);
  });

  it("does not schedule a review job when its initial pending status cannot be recorded", () => {
    const result = pullEvent({
      expected: { status: 1, posts: 1 },
      responses: {
        [publishPath()]: { status: 403, body: { message: "Forbidden" } },
      },
    });
    expect(result.waits).toEqual([]);
  });

  it.each([
    { action: "closed", patch: { state: "closed" } },
    { action: "edited", patch: { base: { ref: "release/1", repo: repository } } },
  ])("refreshes the remaining PR after a duplicate is $action", ({ action, patch }) => {
    const result = pullEvent({
      expected: { include: [reviewEntry(43)] },
      action,
      pullRequest: patch,
      responses: {
        [statusesPath()]: reply([recordedPullRequest(42), recordedPullRequest(43)]),
        [pullPath(43)]: reply({ ...pullRequest, number: 43 }),
      },
    });
    expect(result.paths).toEqual([pullPath(), statusesPath(), pullPath(43), publishPath()]);
  });

  it("refreshes both the changed PR and PRs remaining on its previous head after a push", () => {
    const nextHead = otherHead;
    const result = pullEvent({
      action: "synchronize",
      event: { before: head },
      pullRequest: { head: { ...pullRequest.head, sha: nextHead } },
      responses: {
        [statusesPath(nextHead)]: reply([]),
        [statusesPath()]: reply([42, 43, 44].map(recordedPullRequest)),
        [pullPath(43)]: reply(changedPull(43)),
        [pullPath(44)]: reply(changedPull(44, "c".repeat(40))),
      },
      expected: { include: [reviewEntry(42, nextHead), reviewEntry(43)] },
    });
    expect(result.requests.filter((request) => request.path.includes("/commits/"))).toEqual([
      get(statusesPath(nextHead)),
      get(statusesPath()),
    ]);
  });

  it("does not use forged or unrelated status descriptions as recorded PR identities", () => {
    const result = pullEvent({
      expected: { include: [] },
      action: "closed",
      pullRequest: { state: "closed" },
      responses: {
        [statusesPath()]: reply([
          { ...recordedPullRequest(98), ...creator("contributor", "User") },
          { ...recordedPullRequest(99), context: "unrelated/status" },
        ]),
      },
    });
    expect(result.requests).toHaveLength(2);
  });

  it.each<[string, string, Options]>([
    [
      "recorded PR identities",
      statusesPath(),
      {
        eventName: "pull_request_target",
        event: { action: "closed", pull_request: { number: 42 } },
        pullRequest: { state: "closed" },
      },
    ],
    ["commit associations", associationsPath, { run: { pull_requests: [] } }],
  ])("fails closed when %s cannot be read", (_name, route, options) => {
    const result = evaluate({
      expected: { status: 1 },
      ...options,
      responses: { [route]: { status: 403, body: { message: "Forbidden" } } },
    });
    expect(result.paths.at(-1)).toBe(route);
  });

  it.each<[string, string, boolean?, string?, boolean?]>([
    ["created", " \r\n /allow-dependencies-change \r\n/allow-security-sensitive-change\n"],
    ["edited", "Removed", true, "/allow-dependencies-change"],
    ["edited", "/allow-dependencies-change", true, "Thanks"],
    ["deleted", "/allow-security-sensitive-change"],
    ["created", "/allow-dependencies-change-extra", false],
    ["created", "/allow-dependencies-change\nThanks", false],
    ["created", "> /allow-dependencies-change", false],
    ["edited", "Removed", false, "Please post /allow-dependencies-change"],
    ["created", "/allow-security-sensitive-change", false, undefined, true],
  ])(
    "selects only approval command activity: %j",
    (action, body, selection, previousBody, issueOnly = false) => {
      const selected = selection ?? true;
      const result = evaluate({
        expected: { include: selected ? [reviewEntry()] : [] },
        eventName: "issue_comment",
        event: {
          action,
          issue: { number: 42, ...(issueOnly ? {} : { pull_request: {} }) },
          comment: { body },
          changes: { body: { from: previousBody } },
        },
      });
      if (!selected) {
        expect(result.requests).toEqual([]);
      }
    },
  );

  const refreshBody = `/refresh-security-review ${head}`;
  const refreshEvent = {
    action: "created",
    issue: { number: 42, pull_request: {} },
    comment: { body: refreshBody, user: { login: "maintainer", type: "User" } },
  };
  const permissionPath = `${prefix}/collaborators/maintainer/permission`;

  it.each(["maintain", "admin"])(
    "refreshes the exact current head for a human with live %s access",
    (role_name) => {
      const result = evaluate({
        eventName: "issue_comment",
        event: {
          ...refreshEvent,
          comment: { ...refreshEvent.comment, body: ` \r\n${refreshBody}\r\n ` },
        },
        responses: { [permissionPath]: reply({ role_name }) },
      });
      // Keep the head-only matrix: frozen native admission names this exact job.
      expect(result.matrix).toEqual({ include: [{ pr: 42, head }] });
      expect(result.requests).toEqual([
        get(pullPath()),
        get(permissionPath),
        { path: publishPath(), method: "POST" },
      ]);
    },
  );

  it.each([
    `${refreshBody} extra`,
    refreshBody.toUpperCase(),
    `/refresh-security-review ${head.slice(1)}`,
    `/refresh-security-review ${head}0`,
    `> ${refreshBody}`,
    `\`${refreshBody}\``,
    `${refreshBody}\n/allow-security-sensitive-change`,
    `/allow-dependencies-change\n${refreshBody}`,
  ])("ignores malformed or mixed refresh body %j without API effects", (body) => {
    const result = evaluate({
      eventName: "issue_comment",
      event: { ...refreshEvent, comment: { ...refreshEvent.comment, body } },
      expected: { include: [] },
    });
    expect(result.requests).toEqual([]);
  });

  it.each([
    { action: "edited" },
    { action: "deleted" },
    { issue: { number: 42 } },
    { comment: { body: refreshBody, user: { login: "automation[bot]", type: "Bot" } } },
    { comment: { body: refreshBody, user: { type: "User" } } },
  ])("does not publish for ineligible refresh activity %j", (event) => {
    evaluate({
      eventName: "issue_comment",
      event: { ...refreshEvent, ...event },
      expected: { include: [] },
    });
  });

  it.each([
    { head: { ...pullRequest.head, sha: otherHead } },
    { state: "closed" },
    { draft: true },
    { base: { ref: "release", repo: repository } },
    { base: { ref: "main", repo: { full_name: "other/repository" } } },
  ])("does not publish for an ineligible live refresh target %j", (pullPatch) => {
    evaluate({
      eventName: "issue_comment",
      event: refreshEvent,
      pullRequest: pullPatch,
      expected: { include: [] },
    });
  });

  it.each(["write", "triage", "read", "custom-maintainer", undefined])(
    "does not publish for live role %s",
    (role_name) => {
      evaluate({
        eventName: "issue_comment",
        event: refreshEvent,
        responses: { [permissionPath]: reply({ role_name, permission: "admin" }) },
        expected: { include: [] },
      });
    },
  );

  it.each([404, 403, 500])("handles permission lookup HTTP %s without publication", (status) => {
    evaluate({
      eventName: "issue_comment",
      event: refreshEvent,
      responses: { [permissionPath]: { status, body: { message: "Unavailable" } } },
      expected: { status: status === 404 ? 0 : 1, include: [] },
    });
  });

  it.each([undefined, "", "0", "-1", "123x", "9007199254740992"])(
    "rejects a replay with invalid run ID %s before any API request",
    (completed_ci_run_id) => {
      const result = evaluate({
        expected: { status: 1 },
        eventName: "workflow_dispatch",
        event: {
          inputs: { completed_ci_run_id },
        },
      });
      expect(result).toMatchObject({
        error: "CI event has no valid workflow run identifier.",
        requests: [],
      });
    },
  );

  it("replays a completed CI run through the live-head resolver", () => {
    const result = evaluate({
      eventName: "workflow_dispatch",
      event: { inputs: { completed_ci_run_id: "123" } },
    });
    expect(result.paths).toEqual([
      `${prefix}/actions/runs/123`,
      `${prefix}/actions/workflows/ci.yml`,
      pullPath(),
      publishPath(),
    ]);
  });

  it.each([
    { name: "non-completed run", run: { status: "in_progress" }, status: 0 },
    { name: "wrong workflow", run: { workflow_id: 999 }, status: 1 },
    { name: "wrong repository", run: { repository: { full_name: "other/repository" } }, status: 1 },
    {
      name: "stale PR head",
      pullRequest: { head: { ...pullRequest.head, sha: otherHead } },
      status: 0,
    },
  ])("rejects replay of $name", ({ run: runPatch, pullRequest: pullRequestPatch, status }) => {
    evaluate({
      eventName: "workflow_dispatch",
      event: { inputs: { completed_ci_run_id: "123" } },
      run: runPatch,
      pullRequest: pullRequestPatch,
      expected: { status, include: [] },
    });
  });

  it.each([
    {
      name: "release fallback",
      changedRun: { event: "workflow_dispatch", display_title: `CI release gate ${head}` },
      associated: false,
    },
    { name: "fork association", changedRun: { pull_requests: [] }, associated: true },
  ])("reevaluates $name against the live head", ({ changedRun, associated }) => {
    const result = evaluate({ run: changedRun });
    expect(result.paths).toEqual([
      `${prefix}/actions/runs/123`,
      `${prefix}/actions/workflows/ci.yml`,
      ...(associated ? [associationsPath] : []),
      pullPath(),
      publishPath(),
    ]);
    expect(result.requests.slice(0, -1).every((request) => request.method === "GET")).toBe(true);
  });

  it("passes the observed completed attempt to its review", () => {
    evaluate({
      run: { run_attempt: 3 },
      expected: { include: [completionEntry(42, head, 123, 3)] },
    });
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
    evaluate({ ...options, expected: { include: [] } });
  });

  it.each([
    { workflow_id: 789 },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "other/repository" } },
    { head_sha: "b".repeat(40) },
    { run_attempt: 0 },
    { run_attempt: undefined },
  ])("refuses a CI event whose live identity changed: %j", (changedRun) => {
    const result = evaluate({ run: changedRun, expected: { status: 1 } });
    expect(result.requests).not.toContainEqual({ path: `${prefix}/pulls/42`, method: "GET" });
  });

  it.each([{ status: 200 }, { status: 404 }, { status: 422 }, { status: 200, child: true }])(
    "falls back to the exact fork branch when commit association is $status, child $child",
    ({ status, child }) => {
      const result = evaluate({
        run: { pull_requests: [] },
        responses: {
          [associationsPath]: {
            status,
            body:
              status === 200 ? (child ? [{ number: 43 }] : []) : { message: "Commit unavailable" },
          },
          [pullPath(43)]: reply(changedPull(43, otherHead)),
          [branchPath]: reply([{ number: 42 }]),
        },
      });
      expect(result.paths).not.toContain(`${prefix}/pulls?per_page=100&page=1`);
    },
  );
});

describe("scheduled reconciliation", () => {
  it.each<[string, NonNullable<Options["responses"]>, boolean?, Selection?]>([
    [
      "covers the previous pass's grace period",
      {
        [scheduledRunsPath]: reply({ workflow_runs: [{ created_at: at("23:45") }] }),
        [ciRunsPath.replace("20%3A00", "20%3A40")]: runListing([
          completed({ updated_at: at("23:43") }),
          completed({ id: 122, head_sha: otherHead, updated_at: at("23:39") }),
        ]),
      },
    ],
    [
      "dedupes reruns by highest run id",
      {
        [ciRunsPath]: runListing([completed({ id: 124 }), completed({ updated_at: at("23:20") })]),
      },
      true,
      [completionEntry(42, head, 124)],
    ],
    [
      "uses the current PR head across completed heads",
      {
        [ciRunsPath]: runListing([completedRun, completed({ id: 122, head_sha: otherHead })]),
        [statusesPath(otherHead)]: reply([]),
      },
      false,
    ],
  ])("%s", (_name, responses, singleStatus, include) => {
    const result = scheduled(responses, include ? { include } : undefined);
    if (singleStatus ?? true) {
      expect(result.statusRequests).toEqual([get(statusesPath())]);
    }
  });

  it.each([
    statusCase("stale success", [gateStatus("success", at("23:30"))]),
    statusCase("pending after completion", [gateStatus("pending", at("23:41"))]),
    statusCase("foreign successes", [
      gateStatus("success", at("23:45"), creator("foreign-bot[bot]")),
      gateStatus("success", at("23:44"), creator("github-actions[bot]", "User")),
      gateStatus("pending", at("23:41")),
      gateStatus("success", at("23:20")),
    ]),
    ...[at("23:41"), completedRun.updated_at].map((created_at) =>
      statusCase(`settled ${created_at}`, [settledGate(created_at)], false),
    ),
    statusCase("settled page", [settledGate(completedRun.updated_at)], false, true),
    statusCase("missing page", [], true, true),
  ])("reads the newest owned result for $name", ({ statuses, selected, paged }) => {
    const result = scheduled(
      {
        [statusesPath()]: reply(
          paged
            ? Array.from({ length: 100 }, () =>
                gateStatus("success", at("23:45"), creator("foreign-bot[bot]")),
              )
            : statuses,
        ),
        ...(paged ? { [statusesPath(head, 2)]: reply(statuses) } : {}),
      },
      { include: selected ? [completionEntry()] : [] },
    );
    if (selected) {
      expect(result.requests).toContainEqual(get(ciRunsPath));
    } else {
      expect(result.requests.some(({ path }) => path.includes("/pulls/"))).toBe(false);
    }
    expect(result.statusRequests).toEqual(
      (paged ? [1, 2] : [1]).map((page) => get(statusesPath(head, page))),
    );
  });

  it("bisects a 1500-run creation range and fully pages both inclusive slices", () => {
    const firstSlice = ciRunsPath.replace("2026-01-02T00%3A00", "2026-01-01T22%3A00");
    const secondSlice = ciRunsPath.replace("2026-01-01T20%3A00%3A00", "2026-01-01T22%3A00%3A01");
    const responses: Record<string, Reply> = {
      [ciRunsPath]: runListing([completedRun], 1500),
    };
    for (const [slice, count, offset] of [
      [firstSlice, 800, 0],
      [secondSlice, 700, 800],
    ] as const) {
      Object.assign(
        responses,
        listingPages(pageSizes(count), count, slice, (index) =>
          completed({ id: offset + index + 1 }),
        ),
      );
    }
    const result = scheduled(responses, { include: [completionEntry(42, head, 1500)] });
    expect(result.listingRequests).toEqual(Object.keys(responses).map(get));
  });

  it.each<[number, number[], boolean]>([
    [0, [0], true],
    [201, [100, 100, 0], false],
    [150, Array.from({ length: 10 }, () => 100), false],
  ])("pages total %i until a short page", (total, sizes, complete) => {
    const responses = listingPages(sizes, total);
    const result = scheduled(responses, { status: complete ? 0 : 1, include: [] });
    expect(result.listingRequests).toEqual(Object.keys(responses).map(get));
    if (!complete) {
      expect(result.error).toContain("covered window does not advance");
      return;
    }
    expect(result.statusRequests).toHaveLength(total === 0 ? 0 : 1);
  });

  it("fails an overfull sub-ten-minute slice before status publication or matrix output", () => {
    const ends = ["00:00:00", "22:00:00", "21:00:00", "20:30:00", "20:15:00", "20:07:30"].map(
      (time, index) => `2026-01-${index === 0 ? "02" : "01"}T${time}.000Z`,
    );
    const listingPaths = ends.map(
      (end) =>
        `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&created=${encodeURIComponent(`2026-01-01T20:00:00.000Z..${end}`)}&per_page=100&page=1`,
    );
    const result = scheduled(
      Object.fromEntries(listingPaths.map((path) => [path, runListing([completedRun], 1001)])),
      { status: 1 },
    );
    expect(result.error).toContain(
      "more than 1000 runs in a creation range shorter than ten minutes",
    );
    expect(result.error).toContain("covered window does not advance");
    expect(result.requests).toEqual([get(scheduledRunsPath), ...listingPaths.map(get)]);
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2])(
    "rejects incomplete or invalid listing totals: %s",
    (total_count) => {
      const workflow_runs = total_count === 2 ? [completedRun, completedRun] : [completedRun];
      const result = scheduled(
        { [ciRunsPath]: { body: { total_count, workflow_runs } } },
        { status: 1 },
      );
      expect(result.error).toContain(
        total_count === 2 ? "covered window does not advance" : "invalid total_count",
      );
    },
  );

  it("selects at most 100 of 101 stale candidates, oldest first", () => {
    const count = 101;
    const candidates = Array.from({ length: count }, (_, index) => ({
      ...completedRun,
      id: index + 1,
      head_sha: (index + 1).toString(16).padStart(40, "0"),
      updated_at: new Date(Date.parse(at("23:00")) + Math.floor(index / 2) * 1000).toISOString(),
      pull_requests: [{ number: 1000 - index }],
    }));
    const newestFirst = candidates.toReversed();
    const responses = listingPages(
      pageSizes(count),
      count,
      ciRunsPath,
      (index) => newestFirst[index]!,
    );
    for (const candidate of candidates) {
      responses[statusesPath(candidate.head_sha)] = reply([]);
      responses[pullPath(candidate.pull_requests[0]!.number)] = reply(
        changedPull(candidate.pull_requests[0]!.number, candidate.head_sha),
      );
    }
    const selected = candidates.slice(0, 100);
    const include = selected.map(({ pull_requests, head_sha, id, run_attempt }) =>
      completionEntry(pull_requests[0]!.number, head_sha, id, run_attempt),
    );
    const result = scheduled(responses, { include, truncated: true });
    expect(result.statusRequests).toEqual(
      selected.map((candidate) => get(statusesPath(candidate.head_sha))),
    );
  });
});
