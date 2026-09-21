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
    [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: { body: [] },
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
      expect(result.output).toBe(`matrix={"include":[{"pr":42,"head":"${head}"}]}\nhas-prs=true\n`);
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

  it("fails a PR refresh when recorded PR identities cannot be read", () => {
    expect(
      evaluate({
        eventName: "pull_request_target",
        event: { action: "closed", pull_request: { number: 42 } },
        pullRequest: { state: "closed" },
        responses: {
          [`${prefix}/commits/${head}/statuses?per_page=100&page=1`]: {
            status: 403,
            body: { message: "Forbidden" },
          },
        },
      }),
    ).toMatchObject({ status: 1, output: "" });
  });

  it.each([
    { action: "created", body: "/allow-security-sensitive-change" },
    {
      action: "created",
      body: " \r\n /allow-dependencies-change \r\n/allow-security-sensitive-change\n",
    },
    { action: "edited", body: "Removed", previousBody: "/allow-dependencies-change" },
    {
      action: "edited",
      body: "> /allow-security-sensitive-change",
      previousBody: "/allow-security-sensitive-change",
    },
    { action: "edited", body: "/allow-dependencies-change", previousBody: "Thanks" },
    { action: "deleted", body: "/allow-security-sensitive-change" },
    { action: "deleted", body: "/allow-dependencies-change\n/allow-security-sensitive-change" },
  ])("reevaluates approval comment activity: %j", ({ action, body, previousBody }) => {
    expect(
      evaluate({
        eventName: "issue_comment",
        event: {
          action,
          issue: { number: 42, pull_request: {} },
          comment: { body },
          changes: { body: { from: previousBody } },
        },
      }),
    ).toMatchObject({
      status: 0,
      matrix: { include: [{ pr: 42, head }] },
      published: [{ body: { context: "openclaw/ci-gate", state: "pending" } }],
    });
  });

  it.each([
    { action: "created", body: "Thanks" },
    { action: "edited", body: "Thanks again", previousBody: "Thanks" },
    { action: "deleted", body: "Thanks" },
    { action: "created", body: "Please post /allow-dependencies-change" },
    { action: "created", body: "> /allow-security-sensitive-change" },
    { action: "created", body: "```\n/allow-dependencies-change\n```" },
    { action: "created", body: "/allow-dependencies-change-extra" },
    { action: "created", body: "/allow-dependencies-change\nThanks" },
    { action: "edited", body: "Removed", previousBody: "Please post /allow-dependencies-change" },
    { action: "deleted", body: "> /allow-security-sensitive-change" },
    { action: "created", body: "/ALLOW-DEPENDENCIES-CHANGE" },
    { action: "created", body: " \r\n " },
    { action: "deleted", body: null },
    { action: "created", body: "/allow-security-sensitive-change", issueOnly: true },
  ])(
    "ignores non-approval comments without API reads or status writes: %j",
    ({ action, body, previousBody, issueOnly }) => {
      expect(
        evaluate({
          eventName: "issue_comment",
          event: {
            action,
            issue: { number: 42, ...(issueOnly ? {} : { pull_request: {} }) },
            comment: { body },
            changes: { body: { from: previousBody } },
          },
        }),
      ).toMatchObject({ status: 0, matrix: { include: [] }, requests: [] });
    },
  );

  it("rejects manual inputs rather than providing a dispatch escape hatch", () => {
    expect(
      evaluate({ eventName: "workflow_dispatch", event: { inputs: { pr_number: "42" } } }),
    ).toMatchObject({ status: 1, requests: [] });
  });

  it.each(["success", "failure", "cancelled"])(
    "reevaluates %s CI completion against live workflow and head",
    (conclusion) => {
      const result = evaluate({ run: { conclusion } });
      expect(result).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
      expect(result.requests.map((request) => request.path)).toEqual([
        `${prefix}/actions/runs/123`,
        `${prefix}/actions/workflows/ci.yml`,
        `${prefix}/pulls/42`,
        `${prefix}/statuses/${head}`,
      ]);
      expect(result.requests.slice(0, -1).every((request) => request.method === "GET")).toBe(true);
      expect(result.published).toHaveLength(1);
      expect(result.published[0]?.body?.state).toBe("pending");
    },
  );

  it("refreshes automatically after the supported exact-head release CI fallback", () => {
    expect(
      evaluate({
        run: { event: "workflow_dispatch", display_title: `CI release gate ${head}` },
      }),
    ).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
  });

  it.each(["CI", `CI release gate ${"b".repeat(40)}`])(
    "ignores unrelated manual CI builds named %s",
    (displayTitle) => {
      expect(
        evaluate({
          run: { event: "workflow_dispatch", display_title: displayTitle },
        }),
      ).toMatchObject({ status: 0, matrix: { include: [] } });
    },
  );

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

  it.each([
    { draft: true },
    { state: "closed" },
    { base: { ref: "release/1", repo: repository } },
    { head: { ...pullRequest.head, sha: "b".repeat(40) } },
    { head: { ...pullRequest.head, repo: { id: 100 } } },
  ])("does not retarget completed CI onto another current PR state: %j", (changedPull) => {
    expect(evaluate({ pullRequest: changedPull })).toMatchObject({
      status: 0,
      matrix: { include: [] },
    });
  });

  it("uses associated commits for fork runs with empty workflow associations", () => {
    expect(
      evaluate({
        run: { pull_requests: [] },
        responses: {
          [`${prefix}/commits/${head}/pulls?per_page=100&page=1`]: { body: [{ number: 42 }] },
        },
      }),
    ).toMatchObject({ status: 0, matrix: { include: [{ pr: 42, head }] } });
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

  it("does not turn API authorization failure into an empty or broader PR selection", () => {
    const result = evaluate({
      run: { pull_requests: [] },
      responses: {
        [`${prefix}/commits/${head}/pulls?per_page=100&page=1`]: {
          status: 403,
          body: { message: "Forbidden" },
        },
      },
    });
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
    expect(result.requests.at(-1)?.path).toContain(`/commits/${head}/pulls?`);
  });
});
