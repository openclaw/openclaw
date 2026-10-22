import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const webhook = "https://discord.com/api/webhooks/123/synthetic-webhook-token";
const jobsPath = "/repos/openclaw/openclaw/actions/runs/123/attempts/1/jobs?per_page=100&page=1";
const releaseName = "Prepare and upload iOS release";
type Step = { name: string; conclusion: string };
const makeStep = (conclusion = "success", name = releaseName): Step => ({ name, conclusion });
const job = (conclusion = "success", steps = [makeStep()], name = releaseName) => ({
  name,
  conclusion,
  steps,
});
const successfulJob = job();
const failedJob = job("failure", [makeStep("failure")]);
type Outcome = [conclusion: string | null, detail: string, jobs?: ReturnType<typeof job>[]];
const webhookPath = "/api/webhooks/123/synthetic-webhook-token?wait=true";
type Reply = {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
  error?: string;
};
type Options = {
  platform?: "iOS" | "Android";
  event?: Record<string, unknown>;
  run?: Record<string, unknown>;
  jobs?: unknown[];
  responses?: Record<string, Reply | Reply[]>;
  webhook?: string;
};
type Trace = {
  method: string;
  url?: string;
  body?: { content: string; flags: number; allowed_mentions: { parse: string[] } };
  delay?: number;
  redirect?: string;
  abortable?: boolean;
};

function evaluate(options: Options = {}) {
  const root = tempDirs.make("mobile-store-release-notify-");
  const eventFile = join(root, "event.json");
  const traceFile = join(root, "requests.jsonl");
  const preload = join(root, "fetch.mjs");
  const platform = options.platform ?? "iOS";
  const uploadName = `Prepare and upload ${platform} release`;
  const jobs = options.jobs ?? [job("success", [makeStep("success", uploadName)], uploadName)];
  const responses = {
    [jobsPath]: { body: { total_count: jobs.length, jobs } },
    [webhookPath]: { body: { id: "456" } },
    ...options.responses,
  };
  writeFileSync(
    eventFile,
    JSON.stringify({
      repository: { full_name: "openclaw/openclaw" },
      action: "completed",
      workflow_run: {
        id: 123,
        run_attempt: 1,
        name: `${platform} Store release (weekly)`,
        path: `.github/workflows/${platform.toLowerCase()}-store-release.yml`,
        display_title: `${platform} Store release (weekly)`,
        event: "schedule",
        head_branch: "main",
        head_repository: { full_name: "openclaw/openclaw" },
        status: "completed",
        conclusion: "success",
        ...options.run,
      },
      ...options.event,
    }),
  );
  writeFileSync(
    preload,
    `
import { appendFileSync } from "node:fs";
import { installGuardClock } from ${JSON.stringify(resolve("test/fixtures/github-guard-clock.mjs"))};
installGuardClock(${JSON.stringify(traceFile)});
const responses = ${JSON.stringify(responses)};
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
    url: String(url), method: options.method ?? "GET", redirect: options.redirect,
    abortable: options.signal instanceof AbortSignal,
    body: options.body ? JSON.parse(options.body) : undefined,
  }) + "\\n");
  if (!["https://api.github.com", "https://discord.com"].includes(parsed.origin)) throw new Error("Unexpected API origin");
  const route = responses[parsed.pathname + parsed.search];
  const reply = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
  if (!reply) throw new Error("Unexpected request");
  if (reply.error) throw new Error(reply.error);
  return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
};
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preload, resolve("scripts/github/mobile-store-release-notify.mjs")],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_TOKEN: "synthetic-github-token",
        DISCORD_MOBILE_RELEASE_WEBHOOK_URL: options.webhook ?? webhook,
      },
    },
  );
  const trace: Trace[] = existsSync(traceFile)
    ? readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Trace)
    : [];
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    requests: trace.filter(({ method }) => method !== "WAIT"),
    waits: trace.filter(({ method }) => method === "WAIT").map(({ delay }) => delay),
    posts: trace.filter(({ method }) => method === "POST"),
  };
}

function expression(value: string, github: Record<string, unknown>) {
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), { github });
}

describe("scheduled mobile store release notifications", () => {
  it("keeps webhook credentials behind the scheduled-run guard and trusted default-branch checkout", () => {
    const workflow = parse(
      readFileSync(".github/workflows/mobile-store-release-notify.yml", "utf8"),
    ) as {
      on: { workflow_run: { types: string[]; branches: string[] } };
      permissions: Record<string, string>;
      jobs: {
        notify: {
          if: string;
          environment: string;
          permissions: Record<string, string>;
          steps: {
            uses?: string;
            with?: Record<string, unknown>;
            env?: Record<string, string>;
            run?: string;
          }[];
        };
      };
    };
    const { notify } = workflow.jobs;
    expect(workflow.on.workflow_run).toMatchObject({ types: ["completed"], branches: ["main"] });
    expect(workflow.permissions).toEqual({});
    expect(notify.permissions).toEqual({ contents: "read", actions: "read" });
    const github = {
      sha: "a".repeat(40),
      repository: "openclaw/openclaw",
      event: {
        workflow_run: {
          head_sha: "b".repeat(40),
          head_repository: { full_name: "openclaw/openclaw" },
          event: "schedule",
          display_title: "iOS Store release (weekly)",
        },
      },
    };
    for (const [event, display_title, expected] of [
      ["schedule", "iOS Store release (weekly)", true],
      ["schedule", "Android Store release (weekly)", true],
      ["schedule", "iOS TestFlight distribution", false],
      ["schedule", "Android Internal testing distribution", false],
      ["workflow_dispatch", "iOS Store release (weekly)", false],
    ] as const) {
      Object.assign(github.event.workflow_run, { event, display_title });
      expect(expression(notify.if, github)).toBe(expected);
      if (expected) {
        expect(expression(notify.environment, { event: { workflow_run: { display_title } } })).toBe(
          display_title.startsWith("iOS") ? "ios-store-release" : "android-store-release",
        );
      }
    }
    const checkout = notify.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const ref = checkout?.with?.ref;
    expect(typeof ref).toBe("string");
    expect(expression(String(ref), github)).toBe(github.sha);
    const send = notify.steps.find(
      (step) => step.run === "node scripts/github/mobile-store-release-notify.mjs",
    );
    expect(send?.env?.DISCORD_MOBILE_RELEASE_WEBHOOK_URL).toBe(
      "${{ secrets.DISCORD_MOBILE_RELEASE_WEBHOOK_URL }}",
    );
  });

  it.each([
    ["iOS", "Build uploaded and prepared in App Store Connect."],
    ["Android", "Google Play upload completed."],
  ] as const)("reports a proven %s upload", (platform, detail) => {
    const result = evaluate({ platform });
    expect(result.status, result.output).toBe(0);
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]).toMatchObject({
      url: `${webhook}?wait=true`,
      redirect: "error",
      abortable: true,
      body: {
        content: `✅ **${platform} release uploaded successfully**\n${detail}\n[**View run ↗**](https://github.com/openclaw/openclaw/actions/runs/123/attempts/1)`,
        flags: 4,
        allowed_mentions: { parse: [] },
      },
    });
    expect(result.requests.every((request) => request.abortable)).toBe(true);
  });

  it.each([
    { event: "workflow_dispatch" },
    { display_title: "iOS TestFlight distribution" },
    { display_title: "Android Internal testing distribution" },
    { display_title: "iOS Store screenshots" },
    { display_title: "Android Store release (weekly)" },
    { head_branch: "feature" },
    { head_repository: { full_name: "contributor/openclaw" } },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress" },
  ])("does not notify an ineligible run: %j", (run) => {
    const result = evaluate({ run });
    expect(result).toMatchObject({ status: 0, requests: [], posts: [] });
  });

  it("does not notify a completed event from another repository", () => {
    expect(
      evaluate({ event: { repository: { full_name: "contributor/openclaw" } } }),
    ).toMatchObject({ status: 0, requests: [], posts: [] });
  });

  it("reads every page from the completed attempt, not a later rerun", () => {
    const path = jobsPath.replace("/attempts/1/", "/attempts/2/");
    const result = evaluate({
      run: { run_attempt: 2 },
      responses: {
        [path]: {
          body: { total_count: 2, jobs: [{ name: "qualify / Test", conclusion: "success" }] },
        },
        [path.replace("&page=1", "&page=2")]: { body: { total_count: 2, jobs: [successfulJob] } },
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.requests.slice(0, 2).map((request) => request.url)).toEqual([
      `https://api.github.com${path}`,
      `https://api.github.com${path.replace("&page=1", "&page=2")}`,
    ]);
    expect(result.posts[0]?.body?.content).toContain(
      "✅ **iOS release uploaded successfully · Attempt 2**",
    );
    expect(result.posts[0]?.body?.content).toContain("/attempts/2)");
  });

  it.each<Outcome>([
    ["failure", "The workflow failed during Prepare and upload iOS release."],
    ["timed_out", "The run exceeded its time limit during Prepare and upload iOS release."],
    ["cancelled", "The run was cancelled during Prepare and upload iOS release."],
    ["startup_failure", "GitHub could not start the workflow."],
    ["action_required", "GitHub reported that action is required. Check the run."],
    ["neutral", "The run finished without a confirmed successful release."],
    ["skipped", "The workflow was skipped."],
    ["stale", "GitHub marked the run stale."],
    [null, "The release outcome could not be confirmed. Check the run."],
    ["unrecognized", "The release outcome could not be confirmed. Check the run."],
    ["success", "The store release job was skipped. Upload was not started.", [job("skipped", [])]],
    ...[[], [job("success", [])]].map((jobs): Outcome => [
      "success",
      "The release outcome could not be confirmed. Check the run. Store acceptance is unconfirmed.",
      jobs,
    ]),
    [
      "failure",
      "The workflow failed during Run qualification. The store release job was skipped; upload was not started.",
      [
        job("failure", [makeStep("failure", "Run qualification")], "qualify / iPad"),
        job("skipped", []),
      ],
    ],
    [
      "failure",
      "The workflow failed during Setup Ruby. Upload was not started.",
      [job("failure", [makeStep("failure", "Setup Ruby"), makeStep("skipped")])],
    ],
    [
      "failure",
      "Build uploaded. The workflow failed during Retain release plan and notes.",
      [job("failure", [makeStep("failure", "Retain release plan and notes"), makeStep()])],
    ],
  ])("reports %s release evidence: %s", (conclusion, reason, jobs) => {
    const detail = jobs ? reason : `${reason} Store acceptance is unconfirmed.`;
    const result = evaluate({ run: { conclusion }, jobs: jobs ?? [failedJob] });
    expect(result.status, result.output).toBe(0);
    expect(result.posts[0]?.body).toMatchObject({
      content: expect.stringContaining(`⚠️ **iOS release needs attention**\n${detail}`),
      flags: 4,
    });
  });

  it("reports an unconfirmed result after exhausted metadata retries", () => {
    const result = evaluate({
      responses: { [jobsPath]: { status: 503, body: { secret: webhook } } },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.waits).toEqual([1_000, 2_000]);
    expect(result.posts[0]?.body?.content).toContain(
      "⚠️ **iOS release needs attention**\nRelease job details could not be retrieved.",
    );
    expect(result.output).not.toContain(webhook);
  });

  it("retries transport errors and rate limits without rerunning releases", () => {
    const result = evaluate({
      responses: {
        [webhookPath]: [
          { error: `Failed to fetch ${webhook}` },
          { status: 429, body: { retry_after: 2.5 } },
          { body: { id: "456" } },
        ],
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.waits).toEqual([1_000, 2_500]);
    expect(result.posts).toHaveLength(3);
    expect(result.requests.filter(({ method }) => method === "GET")).toHaveLength(1);
    expect(new Set(result.posts.map(({ body }) => JSON.stringify(body))).size).toBe(1);
    expect(result.output).not.toContain(webhook);
  });

  it.each([
    { status: 400, body: { message: webhook } },
    { status: 503, body: { message: webhook } },
    { status: 429, headers: { "retry-after": "60" }, body: { message: webhook } },
    { error: `Network failure at ${webhook}` },
  ])("fails notification delivery without exposing webhook credentials: %j", (reply) => {
    const result = evaluate({
      responses: { [webhookPath]: reply },
    });
    expect(result.status).toBe(1);
    expect(result.posts.length).toBeLessThanOrEqual(3);
    expect(result.output).toContain("::error::Discord");
    expect(result.output).not.toContain(webhook);
    expect(result.output).not.toContain("synthetic-webhook-token");
  });

  it.each(["", "https://example.com/api/webhooks/123/private-token"])(
    "rejects bad webhooks",
    (value) => {
      const result = evaluate({ webhook: value });
      expect(result).toMatchObject({ status: 1, requests: [] });
      expect(result.output).toContain("DISCORD_MOBILE_RELEASE_WEBHOOK_URL");
      expect(result.output).not.toContain("private-token");
    },
  );
});
