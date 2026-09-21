import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRollupContexts } from "../../scripts/lib/watch-pr-ci-rollup.mts";
import {
  buildFindRunArgs,
  classifyAttachedCiRun,
  classifyRollup,
  classifyRunAttachment,
  parseArgs,
  pollUntilDeadline,
  sanitizeCheckName,
  selectRunAfter,
} from "../../scripts/watch-pr-ci.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import placeholderFixture from "../fixtures/watch-pr-ci-queued-placeholder.js";

const sha = "a".repeat(40);

function runWatcher(
  ghScript: string,
  headSha = sha,
  options: string[] = [],
  clock: "poll" | "wall" | { readClock: string } = "poll",
  envOverrides: NodeJS.ProcessEnv = {},
  notifierPath?: string,
) {
  return withTempDir("openclaw-watch-pr-ci-", async (binDir) => {
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, ghScript);
    chmodSync(ghPath, 0o755);
    const clockPath = join(binDir, "poll-clock.mjs");
    // Evidence fixtures advance polling only, independent of fake gh startup cost.
    // Deadline coverage explicitly retains the real clock and child timeout.
    // NODE_OPTIONS reaches the implementation through its unmodified CLI wrapper.
    writeFileSync(
      clockPath,
      `import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
if (process.argv[1] === ${JSON.stringify(fileURLToPath(new URL("../../scripts/watch-pr-ci.mts", import.meta.url)))}) {
  const now = ${typeof clock === "object" ? `() => Number(readFileSync(${JSON.stringify(clock.readClock)}, "utf8"))` : clock === "wall" ? "Date.now" : "() => 0"};
  const realSleep = timers.setTimeout;
  let waitedMs = 0;
  Date.now = () => now() + waitedMs;
  timers.setTimeout = async (milliseconds, value, options) => {
    const result = await realSleep(0, value, options);
    waitedMs += milliseconds;
    return result;
  };
  syncBuiltinESMExports();
}
`,
    );
    return await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          notifierPath ? "/bin/bash" : process.execPath,
          [
            ...(notifierPath
              ? [
                  "-c",
                  'exec 3>"$1"; shift; exec "$@"',
                  "watcher-notifier",
                  notifierPath,
                  process.execPath,
                ]
              : []),
            "scripts/watch-pr-ci.mjs",
            "42",
            headSha,
            "--attach-timeout",
            "1",
            "--timeout",
            "1",
            "--interval",
            "1",
            ...options,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              ...envOverrides,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(clockPath).href}`,
              PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            },
          },
          (error, stdout, stderr) => {
            const status = error ? error.code : 0;
            if (typeof status !== "number") {
              reject(new Error("watcher process did not report an exit code", { cause: error }));
              return;
            }
            resolve({ status, stdout, stderr });
          },
        );
      },
    );
  });
}

function replayPlaceholder(
  fixture = structuredClone(placeholderFixture),
  evidence: {
    runSnapshots?: unknown[];
    runViewSnapshots?: unknown[];
    jobPages?: unknown[];
    directJobs?: unknown[];
    merged?: boolean;
    watchTimeout?: number;
    delayFirstAlias?: boolean;
    clock?: "poll" | "wall";
    afterAliasScan?: unknown;
    rest?: boolean;
  } = {},
) {
  return withTempDir("openclaw-watch-pr-ci-replay-", async (root) => {
    const payload = join(root, "payload.json");
    const calls = join(root, "calls.jsonl");
    // The live capture is merged. Only lifecycle is reopened for the historical watch.
    if (!evidence.merged) {
      fixture.graphql.data.repository.pullRequest.state = "OPEN";
    }
    writeFileSync(payload, JSON.stringify({ ...fixture, ...evidence }));
    writeFileSync(calls, "");
    const result = await runWatcher(
      `#!/usr/bin/env node
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, "utf8"));
const args = process.argv.slice(2);
const calls = fs.readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const runPath = "repos/openclaw/openclaw/actions/runs/33155056361";
const scanned = calls.some((call) => call[1]?.startsWith("repos/openclaw/openclaw/actions/jobs/"));
const currentGraphql = scanned && fixture.afterAliasScan !== undefined ? fixture.afterAliasScan : fixture.graphql;
let value;
if (args[0] === "browse") {
  console.log("https://github.com/openclaw/openclaw");
  process.exit(0);
}
else if (args.includes("repos/openclaw/openclaw/pulls/42")) {
  const pr = currentGraphql.data.repository.pullRequest;
  value = {
    state: pr.state === "MERGED" ? "closed" : pr.state.toLowerCase(),
    merged_at: pr.state === "MERGED" ? "2026-09-19T00:00:00Z" : null,
    mergeable: pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : null,
    head: { sha: pr.headRefOid },
  };
}
else if (args[0] === "run" && args[1] === "view") {
  const reads = calls.filter((call) => call[0] === "run" && call[1] === "view").length;
  value = fixture.runViewSnapshots?.[Math.min(reads, fixture.runViewSnapshots.length - 1)] ?? fixture.run;
}
else if (args[0] === "api" && args[1] === "graphql") {
  if (fixture.rest) {
    console.error("gh: API rate limit exceeded for fixture-user.");
    process.exit(1);
  }
  value = currentGraphql;
  if (args.some((arg) => arg.includes("checkRunCountsByState"))) {
    const rollup = value.data.repository.pullRequest.statusCheckRollup;
    if (rollup) rollup.contexts = {};
  }
}
else if (args[1]?.includes("/commits/") && args[1].includes("/check-runs?")) {
  const nodes = currentGraphql.data.repository.pullRequest.statusCheckRollup.contexts.nodes;
  value = { total_count: nodes.length, check_runs: nodes.map((node) => ({
    id: node.databaseId, name: node.name, status: node.status.toLowerCase(),
    conclusion: node.conclusion?.toLowerCase() ?? null,
    head_sha: fixture.run.head_sha, check_suite: { id: node.checkSuite.databaseId },
  })) };
}
else if (args[1]?.includes("/commits/") && args[1].includes("/status?")) {
  value = { sha: fixture.run.head_sha, state: "pending", total_count: 0, statuses: [] };
}
else if (args[1]?.includes("/commits/") && args[1].includes("/check-suites?")) {
  const latest_check_runs_count = currentGraphql.data.repository.pullRequest.statusCheckRollup.contexts.nodes.length;
  value = { total_count: 1, check_suites: [{ id: fixture.run.check_suite_id, head_sha: fixture.run.head_sha, status: "completed", conclusion: "success", latest_check_runs_count }] };
}
else if (args[1]?.startsWith("repos/openclaw/openclaw/actions/runs?head_sha=")) {
  value = { total_count: 1, workflow_runs: [{ ...fixture.run, event: "pull_request" }] };
}
else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) value = { workflow_runs: [fixture.run] };
else if (args[1] === runPath) {
  const reads = calls.filter((call) => call[1] === runPath).length;
  value = fixture.runSnapshots?.[Math.min(reads, fixture.runSnapshots.length - 1)] ?? fixture.run;
}
else if (args[1]?.startsWith(runPath + "/attempts/3/jobs?per_page=100&page=")) {
  const page = Number(new URLSearchParams(args[1].split("?")[1]).get("page"));
  value = (fixture.jobPages ?? [fixture.jobs])[page - 1];
  if (value === undefined) throw new Error("missing attempt jobs page");
}
else if (args[1]?.startsWith("repos/openclaw/openclaw/actions/jobs/")) {
  const jobIds = ${JSON.stringify(fixture.directJobs.map((job) => job.id))};
  const jobId = Number(args[1].split("/").at(-1));
  if (fixture.delayFirstAlias && jobId === jobIds[0]) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(["slow-alias-completed"]) + "\\n");
  }
  value = fixture.directJobs[jobIds.indexOf(jobId)];
  if (value === undefined) throw new Error("missing direct job response");
}
else throw new Error("unexpected gh invocation: " + JSON.stringify(args));
console.log(JSON.stringify(value));
`,
      placeholderFixture.run.head_sha,
      evidence.watchTimeout === undefined
        ? []
        : ["--timeout", String(evidence.watchTimeout), "--interval", String(evidence.watchTimeout)],
      evidence.clock,
    );
    return { ...result, calls: readFileSync(calls, "utf8") };
  });
}

function replaySummary({
  state = "PENDING",
  counts = {
    checkRunCountsByState: [{ state: "COMPLETED", count: 200 }],
    statusContextCountsByState: [{ state: "PENDING", count: 1 }],
  },
  runStatus = "in_progress",
  afterRun = {},
  detailContexts,
  supersededFailure = false,
  completeAfter = 3,
}: {
  state?: string;
  counts?: Record<string, unknown>;
  runStatus?: string;
  afterRun?: Record<string, unknown>;
  detailContexts?: unknown;
  supersededFailure?: boolean;
  completeAfter?: number;
}) {
  return withTempDir("openclaw-watch-pr-ci-summary-", async (root) => {
    const callsPath = join(root, "calls.jsonl");
    writeFileSync(callsPath, "");
    const result = await runWatcher(
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = fs.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const runReads = calls.filter((call) => call[0] === "run" && call[1] === "view").length;
const identity = {
  workflow_id: 10, event: "pull_request", head_sha: "${sha}",
  pull_requests: [{ number: 42, head: { sha: "${sha}" } }],
};
const pr = {
  state: "OPEN", mergeable: "MERGEABLE", headRefOid: "${sha}",
  statusCheckRollup: { state: ${JSON.stringify(state)} },
  ...(runReads >= 2 ? ${JSON.stringify(afterRun)} : {}),
};
let value;
if (args[0] === "browse") {
  console.log("https://github.com/openclaw/openclaw");
  process.exit(0);
} else if (args.includes("repos/openclaw/openclaw/pulls/42")) {
  value = { state: "open", mergeable: true, head: { sha: "${sha}" } };
} else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) {
  value = { workflow_runs: [{ ...identity, id: 201, check_suite_id: 20_000 },
    ...(${supersededFailure} ? [{ ...identity, id: 100, check_suite_id: 10_000 }] : [])] };
} else if (args[0] === "run" && args[1] === "view") {
  const completed = ${supersededFailure} ? runReads >= ${completeAfter} : ${runStatus === "completed"};
  value = { status: completed ? "completed" : ${JSON.stringify(runStatus)}, conclusion: completed ? "success" : null };
} else if (args[1] === "repos/openclaw/openclaw/actions/runs/100") {
  value = { ...identity, id: 100, check_suite_id: 10_000 };
} else if (args[0] === "api" && args[1] === "graphql") {
  if (args.some((arg) => arg.includes("checkRunCountsByState"))) {
    pr.statusCheckRollup.contexts = ${JSON.stringify(counts)};
  } else {
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      kind: "CheckRun", databaseId: 1_000 + index, name: "old check " + index,
      status: "COMPLETED", conclusion: ${supersededFailure} && index === 0 ? "CANCELLED" : "SUCCESS",
      checkSuite: { databaseId: 10_000, workflowRun: {
        databaseId: 100, event: "pull_request", workflow: { databaseId: 10 },
      } },
    }));
    nodes.push({ kind: "StatusContext", context: "required status",
      state: ${supersededFailure} ? runReads >= ${completeAfter} ? "SUCCESS" : "PENDING" : pr.statusCheckRollup.state });
    const start = Number(args.find((arg) => arg.startsWith("cursor="))?.slice(7) ?? 0);
    const end = Math.min(start + 100, nodes.length);
    pr.statusCheckRollup.contexts = ${detailContexts !== undefined} ? ${JSON.stringify(detailContexts)} : {
      totalCount: nodes.length, nodes: nodes.slice(start, end),
      pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null },
    };
  }
  value = { data: { repository: { pullRequest: pr } } };
} else {
  throw new Error("unexpected gh invocation: " + JSON.stringify(args));
}
console.log(JSON.stringify(value));
`,
      sha,
      ["--timeout", "3"],
    );
    return {
      ...result,
      calls: readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    };
  });
}

function restCheck(id = 1, patch: Record<string, unknown> = {}) {
  return {
    id,
    name: `check ${id}`,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    check_suite: { id: 20_000 },
    ...patch,
  };
}

function replayRestRollup(
  fixture: {
    graphqlError?: string;
    checkPages?: unknown[];
    statusPages?: unknown[];
    runPages?: unknown[];
    suitePages?: unknown[];
    afterRun?: { checkPages?: unknown[]; statusPages?: unknown[]; suitePages?: unknown[] };
    afterCollection?: Record<string, unknown>;
    runStatuses?: string[];
  } = {},
) {
  return withTempDir("openclaw-watch-pr-ci-fallback-", async (root) => {
    const callsPath = join(root, "calls.jsonl");
    const payloadPath = join(root, "payload.json");
    writeFileSync(callsPath, "");
    writeFileSync(payloadPath, JSON.stringify(fixture));
    const result = await runWatcher(
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = fs.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const original = JSON.parse(fs.readFileSync(${JSON.stringify(payloadPath)}, "utf8"));
const runReads = calls.filter((call) => call[0] === "run" && call[1] === "view").length;
const fixture = { ...original, ...(runReads >= 2 ? original.afterRun : {}) };
const run = { id: 201, workflow_id: 10, check_suite_id: 20_000, event: "pull_request", head_sha: "${sha}" };
const checkPages = fixture.checkPages ?? [{ total_count: 1, check_runs: [${JSON.stringify(restCheck())}] }];
const page = Number(new URLSearchParams(args[1]?.split("?")[1]).get("page") ?? 1);
const collected = calls.some((call) => call[1]?.includes("/check-suites?"));
let value;
if (args[0] === "browse") {
  console.log("https://github.com/openclaw/openclaw");
  process.exit(0);
} else if (args.includes("repos/openclaw/openclaw/pulls/42")) {
  value = { state: "open", merged_at: null, mergeable: true, head: { sha: "${sha}" },
    ...(collected ? fixture.afterCollection : {}) };
} else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) {
  value = { workflow_runs: [run] };
} else if (args[0] === "run" && args[1] === "view") {
  const reads = calls.filter((call) => call[0] === "run" && call[1] === "view").length;
  const snapshots = fixture.runStatuses ?? ["completed"];
  const status = snapshots[Math.min(reads, snapshots.length - 1)];
  value = { status, conclusion: status === "completed" ? "success" : null };
} else if (args[1] === "graphql") {
  console.error(fixture.graphqlError ?? "gh: API rate limit exceeded for fixture-user.");
  process.exit(1);
} else if (args[1]?.includes("/check-runs?filter=latest&")) {
  value = checkPages[page - 1];
} else if (args[1]?.includes("/status?")) {
  value = (fixture.statusPages ?? [{ sha: "${sha}", state: "pending", total_count: 0, statuses: [] }])[page - 1];
} else if (args[1]?.startsWith("repos/openclaw/openclaw/actions/runs?head_sha=")) {
  value = (fixture.runPages ?? [{ total_count: 1, workflow_runs: [run] }])[page - 1];
} else if (args[1]?.includes("/check-suites?")) {
  const checks = checkPages.flatMap((page) => page.check_runs);
  const ids = [...new Set(checks.map((check) => check.check_suite.id))];
  value = (fixture.suitePages ?? [{ total_count: ids.length, check_suites: ids.map((id) => ({
    id, head_sha: "${sha}", status: "completed", conclusion: "success",
    latest_check_runs_count: checks.filter((check) => check.check_suite.id === id).length,
  })) }])[page - 1];
} else {
  throw new Error("unexpected gh invocation: " + JSON.stringify(args));
}
if (value === undefined) throw new Error("missing fixture page");
console.log(JSON.stringify(value));
`,
      sha,
      ["--timeout", "3"],
    );
    return {
      ...result,
      calls: readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    };
  });
}

describe("watch-pr-ci", () => {
  it("parses defaults and overrides", () => {
    expect(parseArgs(["42", sha])).toEqual({
      pr: 42,
      headSha: sha,
      repo: "openclaw/openclaw",
      attachTimeout: 900,
      timeout: 3600,
      interval: 120,
      completion: "rollup",
    });
    expect(
      parseArgs([
        "7",
        sha,
        "--repo",
        "fork/project",
        "--after",
        "1234",
        "--attach-timeout",
        "30",
        "--timeout",
        "90",
        "--interval",
        "5",
        "--completion",
        "ci-run",
      ]),
    ).toMatchObject({
      repo: "fork/project",
      after: 1234,
      attachTimeout: 30,
      timeout: 90,
      interval: 5,
      completion: "ci-run",
    });
    expect(parseArgs(["1", sha.toUpperCase()]).headSha).toBe(sha);
  });

  it("rejects malformed arguments", () => {
    expect(() => parseArgs(["0", sha])).toThrow("pr-number must be a positive integer");
    expect(() => parseArgs(["1", "abc"])).toThrow("full 40-character commit SHA");
    expect(() => parseArgs(["1", sha, "--interval", "0"])).toThrow(
      "--interval must be a positive integer",
    );
    expect(() => parseArgs(["1", sha, "--after", "0"])).toThrow(
      "--after must be a positive integer",
    );
    expect(() => parseArgs(["1", sha, "--completion", "required"])).toThrow(
      "--completion must be rollup or ci-run",
    );
  });

  it("builds a pull-request-only run attachment query", () => {
    expect(buildFindRunArgs("openclaw/openclaw", sha)).toEqual([
      "api",
      "--method",
      "GET",
      "repos/openclaw/openclaw/actions/workflows/ci.yml/runs",
      "-f",
      "event=pull_request",
      "-f",
      `head_sha=${sha}`,
      "-f",
      "per_page=20",
    ]);
  });

  it("filters run ids at and before --after", () => {
    const newer = { id: 102, created_at: "2026-07-23T02:00:00Z" };
    const runs = [newer, { id: 101, created_at: "2026-07-23T01:00:00Z" }];
    expect(selectRunAfter(runs, 101)).toBe(newer);
    expect(selectRunAfter(runs, 102)).toBeUndefined();
    expect(selectRunAfter(runs)).toBe(newer);
  });

  it("skips newer draft runs without weakening the --after boundary", () => {
    const skipped = { id: 103, conclusion: "skipped" };
    const successful = { id: 102, conclusion: "success" };

    expect(selectRunAfter([skipped, successful])).toBe(successful);
    expect(selectRunAfter([skipped, successful], 101)).toBe(successful);
    expect(selectRunAfter([skipped, successful], 102)).toBeUndefined();
    expect(selectRunAfter([skipped])).toBeUndefined();
    for (const conclusion of [null, "failure", "cancelled"]) {
      const attachable = { id: 102, conclusion };
      expect(selectRunAfter([skipped, attachable])).toBe(attachable);
    }
  });

  it.skipIf(process.platform === "win32")(
    "revalidates run status when a newer draft workflow was skipped",
    async () => {
      const result = await runWatcher(
        `#!/usr/bin/env bash
case "$1 $2" in
  "browse "*) printf 'https://github.com/openclaw/openclaw\\n' ;;
  "api --hostname")
    if [ "$4" != "repos/openclaw/openclaw/pulls/42" ]; then exit 2; fi
    printf '{"state":"open","mergeable":true,"head":{"sha":"${sha}"}}\\n'
    ;;
  "api --method")
    case " $* " in
      *" per_page=1 "*) printf '{"workflow_runs":[{"id":202,"conclusion":"skipped"}]}\\n' ;;
      *) printf '{"workflow_runs":[{"id":202,"conclusion":"skipped"},{"id":201,"conclusion":"success"}]}\\n' ;;
    esac
    ;;
  "run view")
    if [ "\${OCTOPOOL_FRESH:-}" != "1" ]; then
      printf '{"status":"queued","conclusion":null}\\n'
    elif [ "$3" = "202" ]; then
      printf '{"status":"completed","conclusion":"skipped"}\\n'
    else
      printf '{"status":"completed","conclusion":"success"}\\n'
    fi
    ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
        sha,
        ["--completion", "ci-run"],
        "poll",
        { OCTOPOOL_FRESH: "0" },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("ATTACHED run=201");
      expect(result.stdout).toContain("GREEN");
    },
  );

  it.skipIf(process.platform === "win32").each([
    {
      label: "active jobs and a failure hidden by queued run status",
      jobs: [
        { name: "tests", status: "in_progress", conclusion: "" },
        { name: "lint", status: "queued", conclusion: null },
        { name: "check-dependencies\u001b[31m\n", status: "completed", conclusion: "failure" },
      ],
      progress:
        'jobs=3 running=1 queued=1 completed=1 other=0 failing=1 failed=["check-dependencies?"]',
    },
    { label: "missing job details", jobs: undefined, progress: "jobs=unknown" },
    { label: "malformed job details", jobs: [{ name: "incomplete" }], progress: "jobs=unknown" },
  ])("reports $label without changing native completion", async ({ jobs, progress }) => {
    await withTempDir("openclaw-watch-pr-ci-progress-", async (root) => {
      const callsPath = join(root, "calls.jsonl");
      writeFileSync(callsPath, "");
      const result = await runWatcher(
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
let value;
if (args[0] === "browse") {
  console.log("https://github.com/openclaw/openclaw");
  process.exit(0);
} else if (args.includes("repos/openclaw/openclaw/pulls/42")) {
  value = { state: "open", mergeable: true, head: { sha: ${JSON.stringify(sha)} } };
} else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) {
  value = { workflow_runs: [{ id: 201 }] };
} else if (args[0] === "run" && args[1] === "view") {
  value = { status: "queued", conclusion: null };
  if (args[args.indexOf("--json") + 1].includes("jobs")) {
    value = ${JSON.stringify({ status: "queued", conclusion: null, jobs })};
  }
} else {
  throw new Error("unexpected gh invocation: " + JSON.stringify(args));
}
console.log(JSON.stringify(value));
`,
        sha,
        ["--completion", "ci-run"],
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain(`STATUS run=queued conclusion=pending ${progress}`);
      expect(result.stdout).toContain("TIMEOUT completion=ci-run");
      expect(result.stdout).not.toContain("\nGREEN");
      expect(result.stdout).not.toContain("\nFAILING");
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        calls.filter((args) => args.includes("repos/openclaw/openclaw/pulls/42")),
      ).toHaveLength(2);
      expect(calls.some((args) => args[0] === "pr" || args.includes("graphql"))).toBe(false);
      expect(calls.some((args) => args.some((arg) => arg.includes("/commits/")))).toBe(false);
      const runReads = calls.filter((args) => args[0] === "run" && args[1] === "view");
      expect(runReads.map((args) => args[args.indexOf("--json") + 1])).toEqual([
        "status,conclusion",
        "status,conclusion,jobs",
      ]);
    });
  });

  it.skipIf(process.platform === "win32").each<{
    label: string;
    phase: "attach" | "watch";
    patch: Record<string, unknown>;
    exitCode: number;
    output: string;
    slowPr?: boolean;
    slowQuota?: boolean;
    notifier?: boolean;
    host?: string;
  }>([
    ...(["attach", "watch"] as const).flatMap((phase) => [
      {
        label: "closed",
        phase,
        patch: { state: "closed" },
        exitCode: 10,
        output: "PR-CLOSED state=CLOSED",
      },
      {
        label: "merged",
        phase,
        patch: { state: "closed", merged_at: "2026-09-19T00:00:00Z" },
        exitCode: 10,
        output: "PR-CLOSED state=MERGED",
      },
      {
        label: "moved head",
        phase,
        patch: { head: { sha: "b".repeat(40) } },
        exitCode: 11,
        output: "HEAD-MOVED",
      },
      {
        label: "conflict",
        phase,
        patch: { mergeable: false },
        exitCode: phase === "attach" ? 12 : 14,
        output: phase === "attach" ? "CONFLICTING mergeable=" : "CONFLICTING-MID-WAIT",
      },
    ]),
    {
      label: "unknown mergeability",
      phase: "attach",
      patch: { mergeable: null },
      exitCode: 0,
      output: "GREEN",
    },
    {
      label: "slow current PR read",
      phase: "watch",
      patch: {},
      slowPr: true,
      exitCode: 16,
      output: "TIMEOUT completion=ci-run",
    },
    {
      label: "slow quota diagnostics",
      phase: "watch",
      patch: {},
      slowQuota: true,
      exitCode: 16,
      output: "TIMEOUT completion=ci-run",
    },
    {
      label: "native notifier",
      phase: "attach",
      patch: {},
      notifier: true,
      exitCode: 0,
      output: "GREEN",
    },
    {
      label: "enterprise port",
      phase: "attach",
      patch: {},
      host: "github.enterprise.invalid:8443",
      exitCode: 0,
      output: "GREEN",
    },
  ])(
    "uses REST for ci-run $phase: $label",
    async ({
      phase,
      patch,
      exitCode,
      output,
      slowPr = false,
      slowQuota = false,
      notifier = false,
      host = "github.com",
    }) => {
      await withTempDir("openclaw-watch-pr-ci-rest-", async (root) => {
        const callsPath = join(root, "calls.jsonl");
        const repo = "fixture-owner/fixture-repo";
        const pullPath = `repos/${repo}/pulls/42`;
        const notifierPath = notifier ? join(root, "notifier") : undefined;
        const readClockPath = join(root, "read-clock");
        if (slowQuota) {
          // Charge request time independently of process startup so the diagnostic
          // gets to exercise its real child timeout, even on a busy host.
          writeFileSync(readClockPath, "0");
        }
        writeFileSync(callsPath, "");
        const result = await runWatcher(
          `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = fs.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const pullPath = ${JSON.stringify(pullPath)};
const reads = calls.filter((call) => call.includes(pullPath)).length;
if (${notifier} && (args[0] === "browse" || args.includes(pullPath))) fs.writeSync(3, args[0] + "\\n");
let value;
if (args[0] === "browse") {
  if (args[args.indexOf("--repo") + 1] !== ${JSON.stringify(repo)}) throw new Error("wrong repository selection");
  console.log("https://" + ${JSON.stringify(host)} + "/" + ${JSON.stringify(repo)});
  process.exit(0);
} else if (args[0] === "api" && args.includes(pullPath)) {
  if (args[args.indexOf("--hostname") + 1] !== ${JSON.stringify(host)}) throw new Error("wrong API host");
  if (args[args.indexOf("-H") + 1] !== "Cache-Control: max-age=0") throw new Error("metadata read must revalidate mutable PR state");
  if (${slowPr} && reads > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(["slow-pr-completed"]) + "\\n");
  }
  if (${slowQuota} && reads > 0) {
    fs.writeFileSync(${JSON.stringify(readClockPath)}, "500");
    console.error("HTTP 429 Too Many Requests");
    process.exit(1);
  }
  value = { state: "open", merged_at: null, mergeable: true, head: { sha: "${sha}" },
    ...(${phase === "attach"} || reads > 0 ? ${JSON.stringify(patch)} : {}) };
} else if (${slowQuota} && args.includes("rate_limit")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(["slow-quota-completed"]) + "\\n");
  value = { resources: {} };
} else if (args.includes("repos/" + ${JSON.stringify(repo)} + "/actions/workflows/ci.yml/runs")) {
  value = { workflow_runs: [{ id: 201 }] };
} else if (args[0] === "run" && args[1] === "view") {
  value = { status: "completed", conclusion: "success" };
} else {
  throw new Error("unexpected gh invocation: " + JSON.stringify(args));
}
console.log(JSON.stringify(value));
`,
          sha,
          ["--repo", repo, "--completion", "ci-run"],
          slowQuota ? { readClock: readClockPath } : slowPr ? "wall" : "poll",
          { OPENCLAW_PR_LOCK_NOTIFY_FD: notifier ? "3" : undefined },
          notifierPath,
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).toContain(output);
        const calls = readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        expect(calls.some((args) => args[0] === "pr" || args.includes("graphql"))).toBe(false);
        expect(calls.some((args) => args.some((arg) => arg.includes("/commits/")))).toBe(false);
        if (phase === "attach" && exitCode !== 0) {
          expect(
            calls.some(
              (args) => args[0] === "run" || args.some((arg) => arg.includes("/actions/")),
            ),
          ).toBe(false);
        } else {
          expect(result.stdout).toContain("ATTACHED run=201");
        }
        expect(calls.filter((args) => args.includes(pullPath))).toHaveLength(
          phase === "attach" && exitCode !== 0 ? 1 : 2,
        );
        expect(calls.filter((args) => args[0] === "browse")).toHaveLength(1);
        if (exitCode !== 0) {
          expect(result.stdout).not.toContain("\nGREEN");
        }
        expect(calls.some((args) => args[0] === "slow-pr-completed")).toBe(false);
        expect(calls.some((args) => args[0] === "slow-quota-completed")).toBe(false);
        expect(calls.filter((args) => args.includes("rate_limit"))).toHaveLength(slowQuota ? 1 : 0);
        if (notifierPath) {
          expect(readFileSync(notifierPath, "utf8")).toBe("browse\napi\napi\n");
        }
      });
    },
  );

  // These replay groups own their CLI process, files, and polling clock per case.
  // Vitest bounds concurrent cases; real-deadline coverage stays in serial groups.
  describe.skipIf(process.platform === "win32")("summary polling", () => {
    it.concurrent("avoids repeating summaries while superseded failures require full polling", async () => {
      const result = await replaySummary({ state: "FAILURE", supersededFailure: true });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout.match(/STATUS rollup=pending/g)).toHaveLength(2);
      expect(result.stdout).toContain("\nGREEN");
      const graphql = result.calls.filter((call) => call[1] === "graphql");
      expect(graphql).toHaveLength(10);
      expect(
        graphql.filter((call) => call.some((arg) => arg.includes("checkRunCountsByState"))),
      ).toHaveLength(1);
      expect(result.calls.at(-1)).toContain("repos/openclaw/openclaw/pulls/42");
    });

    it.concurrent("returns to summary polling when failures clear while CI remains active", async () => {
      const result = await replaySummary({
        state: "FAILURE",
        supersededFailure: true,
        completeAfter: 10,
        afterRun: { statusCheckRollup: { state: "PENDING" } },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("\nGREEN");
      const graphql = result.calls.filter((call) => call[1] === "graphql");
      expect(graphql).toHaveLength(8);
      expect(
        graphql.filter((call) => call.some((arg) => arg.includes("checkRunCountsByState"))),
      ).toHaveLength(2);
    });

    it.concurrent.each<[string, unknown]>([
      ["missing contexts", null],
      ["missing nodes", { totalCount: 0, pageInfo: { hasNextPage: false } }],
      ["missing count", { nodes: [], pageInfo: { hasNextPage: false } }],
      ["missing pagination", { totalCount: 0, nodes: [] }],
      ["no checks", { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } }],
      ...[0, 2].map((totalCount): [string, unknown] => [
        "inconsistent count",
        {
          totalCount,
          nodes: [{ kind: "StatusContext", context: "required", state: "SUCCESS" }],
          pageInfo: { hasNextPage: false },
        },
      ]),
    ])("does not turn a FAILURE with %s into success", async (_label, detailContexts) => {
      const result = await replaySummary({
        state: "FAILURE",
        runStatus: "completed",
        detailContexts,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain("rollup detail evidence is incomplete");
      expect(result.stdout).not.toContain("\nGREEN");
    });

    it.concurrent.each([
      { label: "complete counts", counts: undefined, pending: "1" },
      { label: "missing counts", counts: {}, pending: "unknown" },
      {
        label: "malformed counts",
        counts: {
          checkRunCountsByState: [{ state: "IN_PROGRESS", count: -1 }],
          statusContextCountsByState: [],
        },
        pending: "unknown",
      },
      {
        label: "zero pending counts",
        counts: {
          checkRunCountsByState: [{ state: "COMPLETED", count: 200 }],
          statusContextCountsByState: [{ state: "SUCCESS", count: 1 }],
        },
        pending: "0",
      },
    ])("keeps a 201-context pending poll bounded with $label", async ({ counts, pending }) => {
      const result = await replaySummary({ counts });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain(
        `STATUS rollup=pending github_rollup=PENDING github_pending=${pending}`,
      );
      expect(result.stdout).not.toContain("\nGREEN");
      expect(result.stdout).not.toContain("superseded=");
      const graphql = result.calls.filter((call) => call[1] === "graphql");
      expect(graphql).toHaveLength(3);
      for (const call of graphql) {
        const query = call.find((arg) => arg.startsWith("query="));
        expect(query).toContain("checkRunCountsByState");
        expect(query).toContain("statusContextCountsByState");
        expect(query).not.toMatch(/\b(?:nodes|pageInfo)\b/);
        expect(call.some((arg) => arg.startsWith("cursor="))).toBe(false);
      }
      expect(result.calls.some((call) => call[1]?.includes("/actions/runs/"))).toBe(false);
      expect(result.calls.filter((call) => call[0] === "browse")).toHaveLength(1);
    });

    it.concurrent.each([
      { label: "unchanged success", afterRun: {}, exitCode: 0, output: "GREEN" },
      {
        label: "moved head",
        afterRun: { headRefOid: "b".repeat(40) },
        exitCode: 11,
        output: "HEAD-MOVED",
      },
      { label: "closed PR", afterRun: { state: "CLOSED" }, exitCode: 10, output: "PR-CLOSED" },
      {
        label: "conflicting PR",
        afterRun: { mergeable: "CONFLICTING" },
        exitCode: 14,
        output: "CONFLICTING-MID-WAIT",
      },
      ...["PENDING", "FAILURE", "ERROR"].map((state) => ({
        label: `same-head ${state}`,
        afterRun: { statusCheckRollup: { state } },
        exitCode: state === "PENDING" ? 16 : 15,
        output: state === "PENDING" ? "TIMEOUT" : "FAILING checks=required status",
      })),
    ])(
      "reobserves $label after the attached run succeeds",
      async ({ afterRun, exitCode, output }) => {
        const result = await replaySummary({ state: "SUCCESS", runStatus: "completed", afterRun });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).toContain(output);
        if (exitCode !== 0) {
          expect(result.stdout).not.toContain("\nGREEN");
        } else {
          const graphql = result.calls.filter((call) => call[1] === "graphql");
          expect(graphql).toHaveLength(2);
          expect(
            graphql.every((call) => call.some((arg) => arg.includes("checkRunCountsByState"))),
          ).toBe(true);
          expect(result.calls.at(-1)?.[1]).toBe("graphql");
          expect(result.calls.some((call) => call[1]?.includes("/actions/runs/"))).toBe(false);
        }
      },
    );
  });

  describe.skipIf(process.platform === "win32")("GraphQL quota fallback", () => {
    it.concurrent("stays on REST across pending polls and verifies success without retrying GraphQL", async () => {
      const result = await replayRestRollup({
        runStatuses: ["in_progress", "in_progress", "in_progress", "completed"],
        checkPages: [
          {
            total_count: 101,
            check_runs: Array.from({ length: 100 }, (_, index) => restCheck(index + 1)),
          },
          { total_count: 101, check_runs: [restCheck(101)] },
        ],
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("\nGREEN");
      expect(result.stdout.match(/WARN GraphQL quota exhausted/g)).toHaveLength(1);
      expect(result.calls.filter((call) => call[1] === "graphql")).toHaveLength(1);
      const checks = result.calls.filter((call) => call[1]?.includes("/check-runs?"));
      expect(checks.length).toBeGreaterThanOrEqual(3);
      expect(checks.every((call) => call.includes("Cache-Control: max-age=0"))).toBe(true);
      expect(checks.some((call) => call[1]?.endsWith("page=2"))).toBe(true);
      expect(result.calls.at(-1)).toContain("repos/openclaw/openclaw/pulls/42");
      expect(result.calls.some((call) => call[1]?.includes("/actions/runs?head_sha="))).toBe(false);
    });

    it.concurrent.each([
      "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "gh: Resource not accessible by integration (HTTP 403)",
      "gh: Bad Gateway (HTTP 502)",
    ])("keeps bounded GraphQL retries for %s", async (graphqlError) => {
      const result = await replayRestRollup({ graphqlError });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain("RETRY phase=watch");
      expect(result.stdout).not.toContain("using REST");
      expect(result.stdout).not.toContain("\nGREEN");
      expect(result.calls.filter((call) => call[1] === "graphql")).toHaveLength(3);
      expect(result.calls.some((call) => call[1]?.includes("/commits/"))).toBe(false);
    });

    it.concurrent("keeps a required failure on the second status page blocking", async () => {
      const statuses = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        context: `status ${index}`,
        state: "success",
      }));
      const result = await replayRestRollup({
        statusPages: [
          { sha, state: "failure", total_count: 101, statuses },
          {
            sha,
            state: "failure",
            total_count: 101,
            statuses: [{ id: 101, context: "last required status", state: "failure" }],
          },
        ],
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(15);
      expect(result.stdout).toContain("FAILING checks=last required status");
      expect(result.stdout).not.toContain("\nGREEN");
      expect(result.calls.some((call) => call[1]?.endsWith("/status?per_page=100&page=2"))).toBe(
        true,
      );
      expect(result.calls.filter((call) => call[1]?.includes("/check-runs?"))).toHaveLength(1);
      expect(result.calls.filter((call) => call[1]?.includes("/status?"))).toHaveLength(2);
      expect(result.calls.filter((call) => call[1]?.includes("/check-suites?"))).toHaveLength(1);
    });

    it.concurrent.each(["pending", "failure"])(
      "reobserves a same-head %s status after attached-run success",
      async (state) => {
        const result = await replayRestRollup({
          afterRun: {
            statusPages: [
              { sha, state, total_count: 1, statuses: [{ id: 1, context: "required", state }] },
            ],
          },
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          state === "failure" ? 15 : 16,
        );
        expect(result.stdout).not.toContain("\nGREEN");
        if (state === "failure") {
          expect(result.stdout).toContain("FAILING checks=required");
        }
      },
    );

    it.concurrent.each([
      { label: "moved head", afterCollection: { head: { sha: "b".repeat(40) } }, exitCode: 11 },
      { label: "closed PR", afterCollection: { state: "closed" }, exitCode: 10 },
      { label: "conflicting PR", afterCollection: { mergeable: false }, exitCode: 14 },
    ])("revalidates a $label after REST collection", async ({ afterCollection, exitCode }) => {
      const result = await replayRestRollup({ afterCollection });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).not.toContain("\nGREEN");
    });

    const failedCheck = restCheck(1, { conclusion: "failure" });
    it.concurrent("keeps an unknown completed REST outcome pending", async () => {
      const result = await replayRestRollup({
        checkPages: [{ total_count: 1, check_runs: [restCheck(1, { conclusion: "new_outcome" })] }],
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain("STATUS rollup=pending");
      expect(result.stdout).not.toContain("\nGREEN");
    });
    const workflow = {
      id: 201,
      workflow_id: 10,
      check_suite_id: 20_000,
      event: "pull_request",
      head_sha: sha,
    };
    it.concurrent.each([
      {
        label: "missing check page",
        checkPages: [
          { total_count: 2, check_runs: [restCheck()] },
          { total_count: 2, check_runs: [] },
        ],
      },
      {
        label: "changed check count",
        checkPages: [
          { total_count: 2, check_runs: [restCheck()] },
          { total_count: 3, check_runs: [restCheck(2)] },
        ],
      },
      {
        label: "duplicate check identity",
        checkPages: [{ total_count: 2, check_runs: [restCheck(), restCheck()] }],
      },
      {
        label: "foreign check head",
        checkPages: [{ total_count: 1, check_runs: [restCheck(1, { head_sha: "b".repeat(40) })] }],
      },
      {
        label: "foreign status head",
        statusPages: [{ sha: "b".repeat(40), state: "success", total_count: 0, statuses: [] }],
      },
      {
        label: "duplicate status context",
        statusPages: [
          {
            sha,
            state: "success",
            total_count: 2,
            statuses: [
              { id: 1, context: "required", state: "success" },
              { id: 2, context: "required", state: "success" },
            ],
          },
        ],
      },
      { label: "excess check count", checkPages: [{ total_count: 1_001, check_runs: [] }] },
      { label: "hidden old check suites", suitePages: [{ total_count: 1_001, check_suites: [] }] },
      ...["failure", "unknown"].map((state) => ({
        label: `contradictory ${state} status aggregate`,
        statusPages: [
          {
            sha,
            state,
            total_count: 1,
            statuses: [{ id: 1, context: "required", state: "success" }],
          },
        ],
      })),
      ...[
        { status: "queued", conclusion: null },
        { status: "completed", conclusion: "failure" },
      ].map((outcome) => ({
        label: `${outcome.status}/${outcome.conclusion} suite after successful check collection`,
        suitePages: [
          {
            total_count: 1,
            check_suites: [{ id: 20_000, head_sha: sha, latest_check_runs_count: 1, ...outcome }],
          },
        ],
      })),
      ...[
        { status: "queued", conclusion: null },
        { status: "completed", conclusion: "failure" },
      ].map((outcome) => ({
        label: `new ${outcome.status}/${outcome.conclusion} suite with a missing published check`,
        suitePages: [
          {
            total_count: 2,
            check_suites: [
              {
                id: 20_000,
                head_sha: sha,
                status: "completed",
                conclusion: "success",
                latest_check_runs_count: 1,
              },
              { id: 30_000, head_sha: sha, latest_check_runs_count: 1, ...outcome },
            ],
          },
        ],
      })),
      {
        label: "duplicate workflow identity",
        checkPages: [{ total_count: 1, check_runs: [failedCheck] }],
        runPages: [{ total_count: 2, workflow_runs: [workflow, workflow] }],
      },
      {
        label: "foreign workflow head",
        checkPages: [{ total_count: 1, check_runs: [failedCheck] }],
        runPages: [{ total_count: 1, workflow_runs: [{ ...workflow, head_sha: "b".repeat(40) }] }],
      },
    ])(
      "rejects $label without accepting partial success",
      async ({ label: _label, ...fixture }) => {
        const result = await replayRestRollup(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
        expect(result.stdout).toContain("RETRY phase=watch");
        expect(result.stdout).not.toContain("\nGREEN");
        expect(result.calls.filter((call) => call[1] === "graphql")).toHaveLength(1);
      },
    );

    it.concurrent.each([
      { status: "completed", conclusion: "skipped" },
      { status: "queued", conclusion: null },
    ])(
      "allows a $status empty third-party suite without inventing pending checks",
      async (outcome) => {
        const result = await replayRestRollup({
          suitePages: [
            {
              total_count: 2,
              check_suites: [
                {
                  id: 20_000,
                  head_sha: sha,
                  status: "completed",
                  conclusion: "success",
                  latest_check_runs_count: 1,
                },
                {
                  id: 30_000,
                  head_sha: sha,
                  app: { id: 34598, slug: "github-pages" },
                  latest_check_runs_count: 0,
                  ...outcome,
                },
              ],
            },
          ],
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("\nGREEN");
      },
    );

    it.concurrent.each([
      { label: "same workflow and event", kind: "matching", exitCode: 0 },
      {
        label: "same workflow and event while active",
        kind: "matching",
        exitCode: 16,
        active: true,
      },
      { label: "another event", kind: "event", exitCode: 15 },
      { label: "missing workflow", kind: "missing", exitCode: 15 },
      { label: "ambiguous suite", kind: "ambiguous", exitCode: 15 },
    ])("preserves same-name check ownership with $label", async ({ kind, exitCode, active }) => {
      const previous = {
        ...workflow,
        id: 100,
        check_suite_id: 10_000,
        event: kind === "event" ? "push" : "pull_request",
      };
      const runs = [
        workflow,
        ...(kind === "missing" ? [] : [previous]),
        ...(kind === "ambiguous" ? [{ ...previous, id: 101 }] : []),
      ];
      const result = await replayRestRollup({
        runStatuses: active ? ["in_progress"] : undefined,
        checkPages: [
          {
            total_count: 2,
            check_runs: [
              restCheck(1, { name: "build", conclusion: "failure", check_suite: { id: 10_000 } }),
              restCheck(2, {
                name: "build",
                ...(active ? { status: "in_progress", conclusion: null } : {}),
              }),
            ],
          },
        ],
        runPages: [{ total_count: runs.length, workflow_runs: runs }],
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).toContain(
        exitCode === 0 ? "\nGREEN" : active ? "TIMEOUT" : "FAILING checks=build",
      );
      expect(result.calls.filter((call) => call[1] === "graphql")).toHaveLength(1);
      if (active) {
        expect(result.stdout.match(/STATUS rollup=pending/g)).toHaveLength(3);
        expect(result.calls.filter((call) => call[1]?.includes("/check-runs?"))).toHaveLength(3);
        expect(
          result.calls.filter((call) => call[1]?.includes("/actions/runs?head_sha=")),
        ).toHaveLength(3);
      }
    });
  });

  describe.skipIf(process.platform === "win32")("proxy failures", () => {
    it.concurrent.each([
      ...[
        "407 Proxy Authentication Required",
        'Post "https://api.github.com/graphql": Proxy Authentication Required',
      ].flatMap((error) => [
        { phase: "attach", completion: "rollup", status: 407, exitCode: 2, error },
        { phase: "attach", completion: "ci-run", status: 407, exitCode: 2, error },
        { phase: "watch", completion: "rollup", status: 407, exitCode: 2, error },
        { phase: "watch", completion: "ci-run", status: 407, exitCode: 2, error },
      ]),
      ...[
        { phase: "attach", completion: "rollup", exitCode: 13 },
        { phase: "attach", completion: "ci-run", exitCode: 13 },
        { phase: "watch", completion: "rollup", exitCode: 16 },
        { phase: "watch", completion: "ci-run", exitCode: 16 },
      ].map((scenario) => Object.assign(scenario, { status: 502, error: "502 Bad Gateway" })),
    ])(
      "handles $error during $phase ($completion)",
      async ({ phase, completion, status, exitCode, error }) => {
        const result = await runWatcher(
          `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const marker = path.join(__dirname, "attached");
const phase = fs.existsSync(marker) ? "watch" : "attach";
if (phase === ${JSON.stringify(phase)}) {
  console.error(${JSON.stringify(error)});
  process.exit(1);
}
const args = process.argv.slice(2);
let value;
if (args[0] === "browse") {
  console.log("https://github.com/openclaw/openclaw");
  process.exit(0);
}
else if (args.includes("repos/openclaw/openclaw/pulls/42")) value = { state: "open", mergeable: true, head: { sha: "${sha}" } };
else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) value = { workflow_runs: [{ id: 201 }] };
else if (args[0] === "run" && args[1] === "view") {
  fs.writeFileSync(marker, "");
  value = { status: "in_progress", conclusion: null };
}
else throw new Error("unexpected gh invocation: " + JSON.stringify(args));
console.log(JSON.stringify(value));
`,
          sha,
          ["--completion", completion],
        );

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        if (status === 407) {
          expect(result.stderr).toContain(`PROXY-AUTH-FAILED phase=${phase}`);
          expect(result.stderr).toContain("Restart the watcher in an active run");
          expect(result.stdout).not.toContain("RETRY");
          expect(result.stdout).not.toContain("TIMEOUT");
          expect(result.stdout).not.toContain("NO-RUN-ATTACHED");
        } else {
          expect(result.stdout).toContain(`RETRY phase=${phase}`);
          expect(result.stdout).toContain(error);
          expect(result.stderr).not.toContain("PROXY-AUTH-FAILED");
        }
      },
    );
  });

  describe.skipIf(process.platform === "win32")("PR run replacement ownership", () => {
    const association = (number = 42, baseRef = "main") => ({
      number,
      head: { sha },
      base: { ref: baseRef, sha: "b".repeat(40) },
    });

    it.each<{
      label: string;
      status?: string;
      conclusion?: string | null;
      runPatch?: Record<string, unknown>;
      previousPatch?: Record<string, unknown>;
      lastPreviousPatch?: Record<string, unknown>;
      olderRunOutsidePage?: boolean;
      oldRunCount?: number;
      expectedMetadataReads?: number;
      afterMetadata?: Record<string, unknown>;
      afterMetadataState?: string;
      rollupState?: string;
      slowMetadata?: boolean;
      slowFinalRun?: boolean;
      slowWatchPr?: boolean;
      checkSuiteId?: number | null;
      oldConclusion?: "FAILURE" | "CANCELLED" | "SUCCESS";
      checkEvent?: string;
      newCheckName?: string;
      newCheckEvent?: string | null;
      newCheckConclusion?: string;
      expectedRun?: number;
      completion?: "ci-run";
      exitCode?: number;
      output?: string;
    }>([
      {
        label: "queued replacement",
        status: "queued",
        conclusion: null,
        exitCode: 16,
        output: "TIMEOUT",
      },
      {
        label: "running replacement",
        status: "in_progress",
        conclusion: null,
        exitCode: 16,
        output: "TIMEOUT",
      },
      { label: "successful replacement", exitCode: 0, output: "GREEN" },
      {
        label: "ci-run slow final run",
        completion: "ci-run",
        slowFinalRun: true,
        exitCode: 16,
        output: "TIMEOUT",
      },
      {
        label: "ci-run slow watch PR read",
        completion: "ci-run",
        slowWatchPr: true,
        exitCode: 16,
        output: "TIMEOUT",
      },
      ...[33, 65].map((oldRunCount) => ({
        label: `${oldRunCount}-run authoritative SUCCESS`,
        oldRunCount,
        olderRunOutsidePage: true,
        rollupState: "SUCCESS",
        oldConclusion: "SUCCESS" as const,
        expectedMetadataReads: 0,
        exitCode: 0,
        output: "GREEN",
      })),
      {
        label: "65-run refreshed SUCCESS",
        oldRunCount: 65,
        olderRunOutsidePage: true,
        afterMetadataState: "SUCCESS",
        expectedMetadataReads: 32,
        exitCode: 0,
        output: "GREEN",
      },
      {
        label: "65-run SUCCESS with failed attached run",
        oldRunCount: 65,
        olderRunOutsidePage: true,
        rollupState: "SUCCESS",
        oldConclusion: "SUCCESS",
        conclusion: "failure",
        expectedMetadataReads: 0,
        output: "FAILING checks=CI workflow (failure)",
      },
      ...[32, 33, 65].map((oldRunCount) => ({
        label: `${oldRunCount}-run metadata progress`,
        oldRunCount,
        olderRunOutsidePage: true,
        exitCode: 0,
        output: "GREEN",
      })),
      {
        label: "33-run unknown association",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        previousPatch: { pull_requests: [] },
        expectedMetadataReads: 32,
      },
      {
        label: "33-run foreign association",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        previousPatch: { pull_requests: [association(43)] },
        expectedMetadataReads: 32,
      },
      {
        label: "33-run failed attached run",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        conclusion: "failure",
        expectedMetadataReads: 32,
        output: "FAILING checks=CI workflow (failure)",
      },
      {
        label: "33-run moved head",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        afterMetadata: { headRefOid: "c".repeat(40) },
        expectedMetadataReads: 32,
        exitCode: 11,
        output: "HEAD-MOVED",
      },
      {
        label: "33-run deferred unknown association",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        lastPreviousPatch: { pull_requests: [] },
      },
      {
        label: "33-run deferred foreign association",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        lastPreviousPatch: { pull_requests: [association(43)] },
      },
      {
        label: "33-run independent failed check",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        newCheckName: "new required job",
        newCheckConclusion: "FAILURE",
        expectedMetadataReads: 32,
        output: "FAILING checks=new required job",
      },
      {
        label: "33-run new failure during metadata",
        oldRunCount: 33,
        olderRunOutsidePage: true,
        afterMetadata: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ kind: "StatusContext", context: "new required check", state: "FAILURE" }],
            },
          },
        },
        expectedMetadataReads: 32,
        output: "FAILING checks=new required check",
      },
      {
        label: "21-run same-PR replacement",
        olderRunOutsidePage: true,
        exitCode: 0,
        output: "GREEN",
      },
      {
        label: "21-run same-PR cancellation replacement",
        olderRunOutsidePage: true,
        oldConclusion: "CANCELLED",
        exitCode: 0,
        output: "GREEN",
      },
      {
        label: "21-run unknown older association",
        olderRunOutsidePage: true,
        previousPatch: { pull_requests: [] },
      },
      {
        label: "21-run foreign older association",
        olderRunOutsidePage: true,
        previousPatch: { pull_requests: [association(43)] },
      },
      ...[
        { label: "wrong returned run", previousPatch: { id: 99 } },
        { label: "wrong returned head", previousPatch: { head_sha: "c".repeat(40) } },
        { label: "wrong returned suite", previousPatch: { check_suite_id: 999 } },
        { label: "wrong returned event", previousPatch: { event: "pull_request_target" } },
        { label: "wrong returned workflow", previousPatch: { workflow_id: 20 } },
        {
          label: "moved head",
          afterMetadata: { headRefOid: "c".repeat(40) },
          exitCode: 11,
          output: "HEAD-MOVED",
        },
        {
          label: "closed PR",
          afterMetadata: { state: "CLOSED" },
          exitCode: 10,
          output: "PR-CLOSED",
        },
        {
          label: "conflicting PR",
          afterMetadata: { mergeable: false },
          exitCode: 14,
          output: "CONFLICTING-MID-WAIT",
        },
        {
          label: "new failing check",
          afterMetadata: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ kind: "StatusContext", context: "new required check", state: "FAILURE" }],
              },
            },
          },
          output: "FAILING checks=new required check",
        },
        { label: "slow metadata", slowMetadata: true, exitCode: 16, output: "TIMEOUT" },
        { label: "slow final run", slowFinalRun: true, exitCode: 16, output: "TIMEOUT" },
        {
          label: "running replacement",
          status: "in_progress",
          conclusion: null,
          exitCode: 16,
          output: "TIMEOUT",
        },
      ].map((entry) =>
        Object.assign(entry, { label: `21-run ${entry.label}`, olderRunOutsidePage: true }),
      ),
      {
        label: "same-PR unique cancellation replacement",
        oldConclusion: "CANCELLED",
        newCheckName: "new matrix shard",
        exitCode: 0,
        output: "GREEN",
      },
      {
        label: "unassociated unique cancellation replacement",
        oldConclusion: "CANCELLED",
        newCheckName: "new matrix shard",
        runPatch: { pull_requests: [] },
      },
      {
        label: "another PR's unique cancellation replacement",
        oldConclusion: "CANCELLED",
        newCheckName: "new matrix shard",
        runPatch: { pull_requests: [association(43)] },
        expectedRun: 100,
      },
      {
        label: "unique target cancellation with unbound newer checks",
        oldConclusion: "CANCELLED",
        checkEvent: "pull_request_target",
        newCheckName: "new matrix shard",
      },
      {
        label: "unique target cancellation with unbound newer run metadata",
        oldConclusion: "CANCELLED",
        checkEvent: "pull_request_target",
      },
      {
        label: "same-name replacement from a different event",
        checkEvent: "pull_request_target",
        newCheckName: "old matrix shard",
        newCheckEvent: "pull_request",
      },
      {
        label: "same-name replacement with an unknown event",
        checkEvent: "pull_request_target",
        newCheckName: "old matrix shard",
        newCheckEvent: null,
      },
      {
        label: "same-name same-event target replacement",
        oldConclusion: "CANCELLED",
        checkEvent: "pull_request_target",
        newCheckName: "old matrix shard",
        exitCode: 0,
        output: "GREEN",
      },

      {
        label: "failed replacement",
        conclusion: "failure",
        output: "FAILING checks=CI workflow (failure)",
      },
      {
        label: "another PR with the same head and a different base",
        runPatch: { pull_requests: [association(43, "release/2026.9")] },
        expectedRun: 100,
      },
      { label: "missing replacement association", runPatch: { pull_requests: undefined } },
      { label: "empty replacement association", runPatch: { pull_requests: [] } },
      {
        label: "ambiguous replacement association",
        runPatch: { pull_requests: [association(), association(43)] },
      },
      {
        label: "malformed replacement association",
        runPatch: { pull_requests: [association(), { number: "43", head: { sha } }] },
      },
      { label: "empty prior association", previousPatch: { pull_requests: [] } },
      {
        label: "another PR's prior graph",
        previousPatch: { pull_requests: [association(43, "release/2026.9")] },
      },
      {
        label: "ambiguous prior association",
        previousPatch: { pull_requests: [association(), association(43)] },
      },
      { label: "different replacement event", runPatch: { event: "workflow_dispatch" } },
      { label: "different replacement head", runPatch: { head_sha: "c".repeat(40) } },
      {
        label: "different association head",
        runPatch: { pull_requests: [{ ...association(), head: { sha: "c".repeat(40) } }] },
      },
      { label: "different prior event", previousPatch: { event: "workflow_dispatch" } },
      { label: "different prior head", previousPatch: { head_sha: "c".repeat(40) } },
      { label: "different workflow", runPatch: { workflow_id: 20 } },
      { label: "missing replacement suite", runPatch: { check_suite_id: undefined } },
      { label: "missing prior suite", previousPatch: { check_suite_id: undefined } },
      { label: "mismatched prior check suite", checkSuiteId: 999 },
      { label: "missing prior check suite", checkSuiteId: null },
      {
        label: "same PR rerun after its base changed",
        runPatch: { pull_requests: [association(42, "release/2026.9")] },
        exitCode: 0,
        output: "GREEN",
      },
      {
        label: "existing ci-run completion policy",
        runPatch: { pull_requests: [association(43, "release/2026.9")] },
        completion: "ci-run",
        exitCode: 0,
        output: "GREEN",
      },
      {
        label: "pending ci-run completion policy",
        status: "in_progress",
        conclusion: null,
        completion: "ci-run",
        exitCode: 16,
        output: "TIMEOUT completion=ci-run",
      },
    ])(
      "preserves replacement ownership for $label",
      async ({
        status = "completed",
        conclusion = "success",
        runPatch,
        previousPatch,
        lastPreviousPatch,
        olderRunOutsidePage = false,
        oldRunCount = 1,
        expectedMetadataReads = oldRunCount,
        afterMetadata,
        afterMetadataState,
        rollupState = "FAILURE",
        slowMetadata = false,
        slowFinalRun = false,
        slowWatchPr = false,
        checkSuiteId = 10_000,
        oldConclusion = "FAILURE",
        checkEvent = "pull_request",
        newCheckName,
        newCheckEvent = checkEvent,
        newCheckConclusion = "SUCCESS",
        expectedRun = 201,
        completion,
        exitCode = 15,
        output = "FAILING checks=old matrix shard",
      }) => {
        const identity = {
          workflow_id: 10,
          event: "pull_request",
          head_sha: sha,
          pull_requests: [association()],
        };
        const run = {
          ...identity,
          id: 201,
          check_suite_id: 20_000,
          status,
          conclusion,
          ...runPatch,
        };
        const previous = {
          ...identity,
          id: 100,
          check_suite_id: 10_000,
          status: "completed",
          conclusion: oldConclusion.toLowerCase(),
          ...previousPatch,
        };
        const previousRuns = Array.from({ length: oldRunCount }, (_, index) => ({
          ...previous,
          id: previous.id - index,
          check_suite_id:
            typeof previous.check_suite_id === "number"
              ? previous.check_suite_id - index
              : undefined,
          ...(index === oldRunCount - 1 ? lastPreviousPatch : undefined),
        }));
        const pr = {
          state: "OPEN",
          mergeable: true,
          headRefOid: sha,
          statusCheckRollup: {
            state: rollupState,
            contexts: {
              totalCount: newCheckName ? 2 : 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  kind: "CheckRun",
                  databaseId: 1_000,
                  name: "old matrix shard",
                  status: "COMPLETED",
                  conclusion: oldConclusion,
                  checkSuite: {
                    databaseId: checkSuiteId ?? undefined,
                    workflowRun: {
                      databaseId: 100,
                      event: checkEvent,
                      workflow: { databaseId: 10 },
                    },
                  },
                },
                ...(newCheckName
                  ? [
                      {
                        kind: "CheckRun",
                        databaseId: 2_000,
                        name: newCheckName,
                        status: "COMPLETED",
                        conclusion: newCheckConclusion,
                        checkSuite: {
                          databaseId: 20_000,
                          workflowRun: {
                            databaseId: 201,
                            event: newCheckEvent ?? undefined,
                            workflow: { databaseId: 10 },
                          },
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        };
        const listedRuns = olderRunOutsidePage
          ? [run, ...Array.from({ length: 19 }, (_, index) => ({ ...run, id: 200 - index }))]
          : [run, previous];
        for (let index = 1; index < oldRunCount; index += 1) {
          const old = pr.statusCheckRollup.contexts.nodes[0]!;
          pr.statusCheckRollup.contexts.nodes.push({
            ...old,
            databaseId: 1_000 + index,
            name: `old matrix shard ${index + 1}`,
            checkSuite: {
              databaseId: 10_000 - index,
              workflowRun: {
                databaseId: 100 - index,
                event: "pull_request",
                workflow: { databaseId: 10 },
              },
            },
          });
          pr.statusCheckRollup.contexts.totalCount += 1;
        }
        if (olderRunOutsidePage) {
          // Multiple visible jobs share one exact old-run metadata read.
          pr.statusCheckRollup.contexts.nodes.push({
            ...pr.statusCheckRollup.contexts.nodes[0]!,
            databaseId: 9_001,
            name: "old matrix shard 2",
          });
          pr.statusCheckRollup.contexts.totalCount += 1;
        }
        const result = await withTempDir("openclaw-watch-pr-ci-ownership-", async (root) => {
          const calls = join(root, "calls.jsonl");
          writeFileSync(calls, "");
          const watched = await runWatcher(
            `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = fs.readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const metadataRead = calls.some((call) => call[1] === "repos/openclaw/openclaw/actions/runs/100");
const pr = { ...${JSON.stringify(pr)}, ...(metadataRead ? ${JSON.stringify(afterMetadata ?? {})} : {}) };
if (metadataRead && ${Boolean(afterMetadataState)}) pr.statusCheckRollup.state = ${JSON.stringify(afterMetadataState)};
const runs = ${JSON.stringify(listedRuns)};
const previousRuns = ${JSON.stringify(previousRuns)};
let value;
if (args[0] === "browse") {
  console.log("https://github.com/openclaw/openclaw");
  process.exit(0);
}
else if (args.includes("repos/openclaw/openclaw/pulls/42")) {
  if (${slowWatchPr} && calls.some((call) => call.includes("repos/openclaw/openclaw/pulls/42"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  value = { state: pr.state.toLowerCase(), mergeable: pr.mergeable, head: { sha: pr.headRefOid } };
}
else if (args[0] === "run" && args[1] === "view") {
  if (${slowFinalRun} && calls.some((call) => call[0] === "run" && call[1] === "view")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  value = runs.find((run) => String(run.id) === args[2]);
}
else if (${completion !== "ci-run"} && args[0] === "api" && args[1] === "graphql") {
  if (args.some((arg) => arg.includes("checkRunCountsByState"))) pr.statusCheckRollup.contexts = {};
  value = { data: { repository: { pullRequest: pr } } };
}
else if (args.includes("repos/openclaw/openclaw/actions/workflows/ci.yml/runs")) value = { total_count: ${olderRunOutsidePage ? 21 : 2}, workflow_runs: runs };
else if (args[1]?.startsWith("repos/openclaw/openclaw/actions/runs/")) {
  if (${slowMetadata}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  value = previousRuns[100 - Number(args[1].split("/").at(-1))];
}
else if (args[1]?.includes("/actions/runs?event=pull_request_target")) value = { workflow_runs: [{ ...runs[0], event: "pull_request_target", pull_requests: [] }] };
else throw new Error("unexpected gh invocation: " + JSON.stringify(args));
console.log(JSON.stringify(value));
`,
            sha,
            completion ? ["--completion", completion] : oldRunCount > 1 ? ["--timeout", "6"] : [],
            slowMetadata || slowFinalRun || slowWatchPr ? "wall" : "poll",
          );
          return {
            ...watched,
            calls: readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as string[]),
          };
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).toContain(`ATTACHED run=${expectedRun}`);
        expect(result.stdout).toContain(output);
        expect(result.calls.some((call) => call[0] === "pr")).toBe(false);
        expect(result.calls.some((call) => call.includes("graphql"))).toBe(completion !== "ci-run");
        expect(
          result.calls.filter((call) => call[1] === "repos/openclaw/openclaw/actions/runs/100"),
        ).toHaveLength(olderRunOutsidePage && expectedMetadataReads > 0 ? 1 : 0);
        const metadataReads = result.calls.filter((call) =>
          call[1]?.startsWith("repos/openclaw/openclaw/actions/runs/"),
        );
        expect(metadataReads).toHaveLength(olderRunOutsidePage ? expectedMetadataReads : 0);
        let readsThisPoll = 0;
        for (const call of result.calls) {
          if (call[0] === "run" && call[1] === "view") {
            readsThisPoll = 0;
          }
          if (call[1]?.startsWith("repos/openclaw/openclaw/actions/runs/")) {
            readsThisPoll += 1;
          }
          expect(readsThisPoll).toBeLessThanOrEqual(32);
        }
      },
    );
  });

  describe.skipIf(process.platform === "win32")("queued placeholder CLI evidence", () => {
    it.each([
      { state: "FAILURE", observed: 1 },
      { state: "PENDING", observed: 1 },
      { state: "FAILURE", observed: 2 },
      { state: "PENDING", observed: 1, rest: true },
    ])(
      "reconciles the captured queued group with aggregate $state and $observed observed checks (REST: $rest)",
      async ({ state, observed, rest }) => {
        const fixture = structuredClone(placeholderFixture);
        const rollup = fixture.graphql.data.repository.pullRequest.statusCheckRollup;
        rollup.state = state;
        if (observed === 2) {
          // Synthetic visibility of another captured alias proves group reads are shared.
          const queuedCheck = rollup.contexts.nodes.find(
            (check) => check.databaseId === 98802098786,
          );
          assert(queuedCheck);
          rollup.contexts.nodes.push({ ...queuedCheck, databaseId: 98802098559 });
          rollup.contexts.totalCount += 1;
        }
        const result = await replayPlaceholder(fixture, { watchTimeout: 5, rest });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain(
          `STATUS rollup=green github_rollup=${state} pending=0 superseded=${observed}`,
        );
        expect(result.stdout).toContain("GREEN");
        // Cost and ordering matter: direct proof precedes run revalidation and
        // a fresh rollup and CI-run check, followed by a final PR lifecycle check.
        const calls: string[][] = result.calls
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call[1]?.includes("/attempts/"))).toHaveLength(1);
        const directReads = calls.filter((call) => call[1]?.includes("/actions/jobs/"));
        expect(
          directReads
            .map((call) => Number(call[1]?.split("/").at(-1)))
            .toSorted((left, right) => left - right),
        ).toEqual(fixture.directJobs.map((job) => job.id).toSorted((left, right) => left - right));
        const finalEvidenceRead = calls.findLastIndex(
          (call) => call[1] === "repos/openclaw/openclaw/actions/runs/33155056361",
        );
        expect(finalEvidenceRead).toBeGreaterThan(
          calls.findLastIndex((call) => call[1]?.includes("/actions/jobs/")),
        );
        expect(calls[finalEvidenceRead]).toContain("Cache-Control: max-age=0");
        const finalRollupRead = calls.findLastIndex((call) =>
          rest ? call[1]?.includes("/check-runs?") : call[1] === "graphql",
        );
        expect(finalRollupRead).toBeGreaterThan(finalEvidenceRead);
        expect(calls.findLastIndex((call) => call[0] === "run")).toBeGreaterThan(finalRollupRead);
        if (rest) {
          expect(calls.filter((call) => call[1] === "graphql")).toHaveLength(1);
        }
        expect(calls.at(-1)).toContain("repos/openclaw/openclaw/pulls/42");
        expect(calls.at(-1)).toContain("Cache-Control: max-age=0");
      },
    );

    it.each([
      { aliasCount: 32, exitCode: 0 },
      { aliasCount: 33, exitCode: 16 },
    ])(
      "bounds direct verification of a $aliasCount-alias group",
      async ({ aliasCount, exitCode }) => {
        const fixture = structuredClone(placeholderFixture);
        const alias = fixture.directJobs[0];
        assert(alias);
        for (let index = fixture.directJobs.length; index < aliasCount; index += 1) {
          const extra = { ...alias, id: 1_000_000 + index };
          fixture.jobs.jobs.push(extra);
          fixture.directJobs.push(extra);
        }
        fixture.jobs.total_count = fixture.jobs.jobs.length;
        const result = await replayPlaceholder(fixture, { watchTimeout: exitCode === 0 ? 5 : 1 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        const calls: string[][] = result.calls
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const directReads = calls.filter((call) => call[1]?.includes("/actions/jobs/"));
        expect(directReads).toHaveLength(exitCode === 0 ? aliasCount : 0);
        if (exitCode !== 0) {
          expect(result.stdout).toContain("pending=1");
          expect(result.stdout).not.toContain("GREEN");
        }
      },
    );

    it("bounds a slow alias read by the remaining watcher deadline", async () => {
      const result = await replayPlaceholder(structuredClone(placeholderFixture), {
        delayFirstAlias: true,
        clock: "wall",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain("pending=1");
      expect(result.stdout).not.toContain("GREEN");
      const calls: string[][] = result.calls
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.filter((call) => call[1]?.includes("/actions/jobs/"))).toHaveLength(1);
      expect(result.calls).not.toContain('"slow-alias-completed"');
    });

    it.each([
      {
        label: "moved head",
        patch: { headRefOid: sha, statusCheckRollup: null },
        exitCode: 11,
        output: "HEAD-MOVED",
      },
      { label: "closed PR", patch: { state: "CLOSED" }, exitCode: 10, output: "PR-CLOSED" },
      {
        label: "conflicting PR",
        patch: { mergeable: false },
        exitCode: 14,
        output: "CONFLICTING-MID-WAIT",
      },
    ])("rechecks a $label after alias verification", async ({ patch, exitCode, output }) => {
      const fixture = structuredClone(placeholderFixture);
      const afterAliasScan = structuredClone(fixture.graphql);
      afterAliasScan.data.repository.pullRequest.state = "OPEN";
      Object.assign(afterAliasScan.data.repository.pullRequest, patch);
      const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).toContain(output);
      expect(result.stdout).not.toContain("GREEN");
    });

    it.each([
      { label: "pending", status: "QUEUED", conclusion: null, exitCode: 16 },
      { label: "failed", status: "COMPLETED", conclusion: "FAILURE", exitCode: 15 },
    ])(
      "observes a new $label required check after alias verification",
      async ({ status, conclusion, exitCode }) => {
        const fixture = structuredClone(placeholderFixture);
        const afterAliasScan = structuredClone(fixture.graphql);
        afterAliasScan.data.repository.pullRequest.state = "OPEN";
        const contexts = afterAliasScan.data.repository.pullRequest.statusCheckRollup.contexts;
        Object.assign(contexts, {
          totalCount: contexts.totalCount + 1,
          nodes: [
            ...contexts.nodes,
            { kind: "CheckRun", name: "new required check", status, conclusion },
          ],
        });
        const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).not.toContain("GREEN");
      },
    );

    it.each([
      { label: "starts running", patch: { status: "IN_PROGRESS" }, exitCode: 16 },
      { label: "fails", patch: { status: "COMPLETED", conclusion: "FAILURE" }, exitCode: 15 },
      {
        label: "loses its conclusion",
        patch: { status: "COMPLETED", conclusion: null },
        exitCode: 16,
      },
      { label: "is renamed", patch: { name: "different required check" }, exitCode: 16 },
    ])("does not reuse proof when an alias $label", async ({ patch, exitCode }) => {
      const fixture = structuredClone(placeholderFixture);
      const afterAliasScan = structuredClone(fixture.graphql);
      afterAliasScan.data.repository.pullRequest.state = "OPEN";
      const alias =
        afterAliasScan.data.repository.pullRequest.statusCheckRollup.contexts.nodes.find(
          (check) => check.databaseId === 98802098786,
        );
      assert(alias);
      Object.assign(alias, patch);
      const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).not.toContain("GREEN");
    });

    it.each(
      [
        { status: "IN_PROGRESS", conclusion: null, exitCode: 16 },
        { status: "COMPLETED", conclusion: "FAILURE", exitCode: 15 },
      ].flatMap((outcome) =>
        [false, true].map((initiallyVisible) => Object.assign({}, outcome, { initiallyVisible })),
      ),
    )(
      "keeps a changed lower-ID alias blocking ($status, initially visible: $initiallyVisible)",
      async ({ status, conclusion, exitCode, initiallyVisible }) => {
        const fixture = structuredClone(placeholderFixture);
        const contexts = fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts;
        const queued = contexts.nodes.find((check) => check.databaseId === 98802098786);
        assert(queued);
        const lower = { ...queued, databaseId: 98802098559 };
        if (initiallyVisible) {
          contexts.nodes.push(lower);
          contexts.totalCount += 1;
        }
        const afterAliasScan = structuredClone(fixture.graphql);
        afterAliasScan.data.repository.pullRequest.state = "OPEN";
        const refreshed = afterAliasScan.data.repository.pullRequest.statusCheckRollup.contexts;
        if (!initiallyVisible) {
          refreshed.nodes.push(lower);
          refreshed.totalCount += 1;
        }
        const changed = refreshed.nodes.find((check) => check.databaseId === lower.databaseId);
        assert(changed);
        Object.assign(changed, { status, conclusion });
        const result = await replayPlaceholder(fixture, { afterAliasScan, watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
        expect(result.stdout).not.toContain("GREEN");
      },
    );

    it.each([33155056361, 33155056360])(
      "still supersedes an older failed check from run %s",
      async (runId) => {
        const fixture = structuredClone(placeholderFixture);
        const contexts = fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts;
        const queued = contexts.nodes.find((check) => check.databaseId === 98802098786);
        assert(queued);
        const older = structuredClone(queued);
        Object.assign(older, {
          databaseId: 98790000000,
          status: "COMPLETED",
          conclusion: "FAILURE",
        });
        older.checkSuite.workflowRun.databaseId = runId;
        contexts.nodes.push(older);
        contexts.totalCount += 1;
        const result = await replayPlaceholder(fixture, { watchTimeout: 5 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("GREEN");
      },
    );

    it("rechecks the attached run after refreshing the PR snapshot", async () => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        runViewSnapshots: [fixture.run, fixture.run, { status: "in_progress", conclusion: null }],
        watchTimeout: 5,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).toContain("STATUS rollup=green github_rollup=FAILURE pending=0");
      expect(result.stdout).not.toContain("GREEN");
    });

    it("keeps the captured merged PR closed", async () => {
      const result = await replayPlaceholder(structuredClone(placeholderFixture), { merged: true });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(10);
      expect(result.stdout).toContain("PR-CLOSED state=MERGED");
      expect(result.calls).not.toContain("/actions/");
    });

    it.each([
      ["no same-name replacement", { name: "different job" }],
      ["active replacement", { status: "in_progress", conclusion: null }],
      ["failed replacement", { conclusion: "failure" }],
      ["unexecuted replacement", { runner_id: null, steps: [] }],
      ["another attempt", { run_attempt: 2 }],
      ["another run", { run_id: 33155056362 }],
      ["another head", { head_sha: sha }],
      ["missing attempt", { run_attempt: undefined }],
    ])("keeps pending for %s in the attempt list", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      Object.assign(
        fixture.jobs.jobs.find((job) => job.id === 98802098754)!,
        patch,
      );
      const result = await replayPlaceholder(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.calls).toContain("/attempts/3/jobs?per_page=100&page=1");
    });

    // Independent rejection fixtures keep their own CLI process and clock state.
    // Keep successful scans and short-deadline job scans serial.
    it.concurrent.each([
      ["assigned queued job", { runner_id: 123 }],
      ["executed steps", { steps: [{ status: "completed", conclusion: "success" }] }],
      ["missing steps", { steps: undefined }],
      ["missing runner", { runner_id: undefined }],
      ["different check ID", { id: 98802098787 }],
      ["different name", { name: "different job" }],
      ["different run", { run_id: 33155056362 }],
      ["different head", { head_sha: sha }],
      ["different attempt", { run_attempt: 4 }],
      ["active job", { status: "in_progress" }],
      ["failed job", { conclusion: "failure" }],
    ])("requires direct unexecuted-job proof: %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        watchTimeout: 5,
        directJobs: fixture.directJobs.map((job) =>
          job.id === 98802098786 ? Object.assign({}, job, patch) : job,
        ),
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.calls).toContain('"repos/openclaw/openclaw/actions/jobs/98802098786"');
    });

    it.each([
      ["executed", { steps: [{ status: "completed", conclusion: "success" }] }],
      ["active", { status: "in_progress", runner_id: 123 }],
      ["failed", { status: "completed", conclusion: "failure" }],
      ["malformed", { run_attempt: undefined }],
    ])("keeps the group pending when a non-rollup sibling is %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        directJobs: fixture.directJobs.map((job) =>
          job.id === 98802098559 ? Object.assign({}, job, patch) : job,
        ),
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.calls).toContain('"repos/openclaw/openclaw/actions/jobs/98802098559"');
    });

    it("rejects a newer rerun attempt after collecting REST alias evidence", async () => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        rest: true,
        runSnapshots: [
          fixture.run,
          { ...fixture.run, run_attempt: 4, status: "in_progress", conclusion: null },
        ],
        watchTimeout: 5,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("\nGREEN");
      expect(result.calls).toContain('"repos/openclaw/openclaw/actions/jobs/98802098786"');
      expect(
        result.calls.split("\n").filter((call) => call.startsWith('["api","graphql",')),
      ).toHaveLength(1);
    });

    it.concurrent.each([
      ["missing ID", { id: undefined }],
      ["missing head", { head_sha: undefined }],
      ["missing workflow", { workflow_id: undefined }],
      ["missing attempt", { run_attempt: undefined }],
      ["different workflow", { workflow_id: 1 }],
      ["different workflow path", { path: ".github/workflows/other.yml" }],
      ["different head", { head_sha: sha }],
      ["different run", { id: 33155056362 }],
      ["active newer attempt", { run_attempt: 4, status: "in_progress", conclusion: null }],
      ["failed newer attempt", { run_attempt: 4, conclusion: "failure" }],
      ["cancelled newer attempt", { run_attempt: 4, conclusion: "cancelled" }],
      ["successful newer attempt", { run_attempt: 4 }],
    ])("rejects changed run evidence after collecting jobs: %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const result = await replayPlaceholder(fixture, {
        watchTimeout: 5,
        runSnapshots: [fixture.run, { ...fixture.run, ...patch }],
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.stdout).not.toContain("GREEN");
      const runReads = result.calls
        .split("\n")
        .filter((call) => call.includes('"repos/openclaw/openclaw/actions/runs/33155056361"'));
      expect(runReads.length).toBeGreaterThanOrEqual(2);
    });

    it.concurrent.each([
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "success" },
    ])(
      "does not ignore an extra $status/$conclusion same-name sibling",
      async ({ status, conclusion }) => {
        const fixture = structuredClone(placeholderFixture);
        const replacement = fixture.jobs.jobs.find((job) => job.id === 98802098754);
        assert(replacement);
        const result = await replayPlaceholder(fixture, {
          jobPages: [
            {
              total_count: fixture.jobs.total_count + 1,
              jobs: [...fixture.jobs.jobs, { ...replacement, id: 98802098799, status, conclusion }],
            },
          ],
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
        expect(result.calls).toContain("/attempts/3/jobs?per_page=100&page=1");
      },
    );

    it.concurrent.each([
      [
        "unrelated workflow",
        { checkSuite: { workflowRun: { databaseId: 33155056361, workflow: { databaseId: 1 } } } },
      ],
      [
        "unrelated run",
        {
          checkSuite: {
            workflowRun: { databaseId: 33155056362, workflow: { databaseId: 209874334 } },
          },
        },
      ],
      ["missing check ID", { databaseId: undefined }],
      ["App check without lineage", { checkSuite: undefined }],
      ["in-progress check", { status: "IN_PROGRESS" }],
      [
        "required status context",
        { kind: "StatusContext", context: "required status", state: "PENDING" },
      ],
    ])("does not reconcile %s", async (_label, patch) => {
      const fixture = structuredClone(placeholderFixture);
      const queuedCheck =
        fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts.nodes.find(
          (check) => check.databaseId === 98802098786,
        );
      assert(queuedCheck);
      Object.assign(queuedCheck, patch);
      const result = await replayPlaceholder(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(16);
      expect(result.calls).not.toContain("/attempts/");
      expect(result.calls).toContain('["api","graphql",');
    });

    it.concurrent.each([
      [
        "pending required App check",
        { kind: "CheckRun", name: "required App", status: "QUEUED" },
        16,
      ],
      [
        "failed required App check",
        { kind: "CheckRun", name: "required App", status: "COMPLETED", conclusion: "FAILURE" },
        15,
      ],
      [
        "pending required status context",
        { kind: "StatusContext", context: "required status", state: "EXPECTED" },
        16,
      ],
      [
        "failed required status context",
        { kind: "StatusContext", context: "required status", state: "FAILURE" },
        15,
      ],
      [
        "unknown completed conclusion",
        { kind: "CheckRun", name: "required App", status: "COMPLETED" },
        16,
      ],
    ] as const)("keeps %s independently blocking", async (_label, sibling, exitCode) => {
      const fixture = structuredClone(placeholderFixture);
      const contexts = fixture.graphql.data.repository.pullRequest.statusCheckRollup.contexts;
      // Synthetic counterexamples add a separate, lineage-less required context.
      Object.assign(contexts, {
        totalCount: contexts.totalCount + 1,
        nodes: [...contexts.nodes, sibling],
      });
      const result = await replayPlaceholder(fixture, { watchTimeout: 5 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(result.stdout).not.toContain("GREEN");
      expect(result.stdout).toContain(
        `STATUS rollup=${exitCode === 16 ? "pending" : "failing"} github_rollup=FAILURE`,
      );
      if (exitCode === 16) {
        expect(result.stdout).toContain("superseded=1");
        expect(result.stdout).toContain("TIMEOUT github_rollup=FAILURE");
      }
    });

    it.concurrent.each(["unknown", "truncated", "unfinished pagination", "missing count"])(
      "does not green an %s rollup",
      async (scenario) => {
        const fixture = structuredClone(placeholderFixture);
        const rollup = fixture.graphql.data.repository.pullRequest.statusCheckRollup;
        if (scenario === "unknown") {
          rollup.state = "UNKNOWN";
        } else if (scenario === "truncated") {
          rollup.contexts.totalCount += 1;
        } else if (scenario === "missing count") {
          Object.assign(rollup.contexts, { totalCount: undefined });
        } else {
          rollup.contexts.pageInfo.hasNextPage = true;
        }
        const result = await replayPlaceholder(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
        expect(result.stdout).not.toContain("GREEN");
        expect(result.calls).not.toContain("/attempts/");
        expect(result.calls).toContain('["api","graphql",');
      },
    );

    it.each(["in_progress", "queued", "completed"])(
      "avoids evidence scans on routine %s polls",
      async (status) => {
        const fixture = structuredClone(placeholderFixture);
        fixture.run.status = status;
        if (status === "completed") {
          const rollup = fixture.graphql.data.repository.pullRequest.statusCheckRollup;
          rollup.state = "SUCCESS";
          rollup.contexts.nodes = rollup.contexts.nodes.slice(0, 1);
          rollup.contexts.totalCount = 1;
        }
        const result = await replayPlaceholder(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          status === "completed" ? 0 : 16,
        );
        expect(result.calls).not.toContain("/attempts/");
        expect(result.calls).not.toContain("/actions/jobs/");
      },
    );

    it.each(["complete", "missing page", "changed count", "duplicate IDs", "over limit"])(
      "requires complete bounded attempt pagination: %s",
      async (scenario) => {
        const fixture = structuredClone(placeholderFixture);
        // Synthetic pagination padding from the captured successful sibling; IDs/names
        // are deliberately unique so the target group only appears on the second page.
        const padding = Array.from({ length: 100 }, (_, index) => ({
          ...fixture.jobs.jobs.find((job) => job.id === 98802098742)!,
          id: scenario === "duplicate IDs" ? 1_000 : 1_000 + index,
          name: `pagination sibling ${index}`,
        }));
        const firstPage = { total_count: 100 + fixture.jobs.total_count, jobs: padding };
        const lastPage = { total_count: firstPage.total_count, jobs: fixture.jobs.jobs };
        const jobPages = [firstPage, lastPage];
        if (scenario === "missing page") {
          jobPages.pop();
        }
        if (scenario === "changed count") {
          lastPage.total_count += 1;
        }
        if (scenario === "over limit") {
          firstPage.total_count = 1_001;
        }
        const result = await replayPlaceholder(fixture, {
          jobPages,
          watchTimeout: scenario === "complete" ? 5 : 1,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(
          scenario === "complete" ? 0 : 16,
        );
        if (scenario === "complete") {
          expect(result.calls).toContain("per_page=100&page=2");
        }
      },
    );
  });

  it("sanitizes untrusted check names for terminal output", () => {
    expect(sanitizeCheckName("plain ASCII / check (1)")).toBe("plain ASCII / check (1)");
    expect(sanitizeCheckName("Crème 日本語 １２３")).toBe("Crème 日本語 １２３");
    expect(sanitizeCheckName("unit\n\r\t\u0000check")).toBe("unit?check");
    expect(sanitizeCheckName("safe\u001b[31mred\u001b[0m text")).toBe("safe?red? text");
    expect(sanitizeCheckName("link\u001b]8;;https://example.com\u0007text\u001b]8;;\u0007")).toBe(
      "link?text?",
    );
    expect(sanitizeCheckName("left\u202Eright 😀")).toBe("left?right ?");
  });

  it("sanitizes failing check and status-context names before classification output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "unit\u001b[31mowned\u001b[0m",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
            { kind: "StatusContext", context: "deploy\nprod", state: "ERROR" },
          ],
        },
      }).failingNames,
    ).toEqual(["deploy?prod", "unit?owned?"]);
  });

  it("polls once more after the deadline-clamped final wait", async () => {
    let now = 0;
    const waits: number[] = [];
    let polls = 0;
    const result = await pollUntilDeadline({
      deadline: 1_000,
      interval: 120,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      poll: () => (++polls === 2 ? "transitioned" : undefined),
    });

    expect(result).toBe("transitioned");
    expect(waits).toEqual([1_000]);
    expect(polls).toBe(2);
  });

  it("times out only after polling at the deadline", async () => {
    let now = 0;
    let polls = 0;
    const result = await pollUntilDeadline({
      deadline: 1_000,
      interval: 120,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      poll: () => {
        polls += 1;
        return undefined;
      },
    });

    expect(result).toBeUndefined();
    expect(now).toBe(1_000);
    expect(polls).toBe(2);
  });

  it("warns for an already-completed late attachment without changing attachment", () => {
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" })).toEqual({
      attach: true,
      warning:
        "WARN attaching to already-completed run 102 (started before watcher); pass --after 102 to require a fresh run",
    });
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" }, 101)).toEqual(
      { attach: true, warning: undefined },
    );
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "skipped" })).toEqual({
      attach: false,
    });
  });

  it("requires aggregate success for a green rollup", () => {
    expect(classifyRollup({ state: "SUCCESS", contexts: { nodes: [] } }).verdict).toBe("GREEN");
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 0, failingNames: [], supersededCount: 0 });
  });

  it("counts pending contexts without deriving the verdict from them", () => {
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "IN_PROGRESS", conclusion: null }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [], supersededCount: 0 });
  });

  it("lets an attached successful CI run finish while an optional context remains pending", () => {
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [
            { kind: "CheckRun", name: "optional proof", status: "IN_PROGRESS", conclusion: null },
          ],
        },
      }).verdict,
    ).toBe("PENDING");
    expect(classifyAttachedCiRun({ status: "completed", conclusion: "success" })).toEqual({
      verdict: "GREEN",
    });
  });

  it.each(["FAILURE", "ERROR"])(
    "keeps identity-less same-name cancellations failing for aggregate %s",
    (state) => {
      expect(
        classifyRollup({
          state,
          contexts: {
            totalCount: 3,
            nodes: [
              {
                kind: "CheckRun",
                name: "Auto response",
                status: "COMPLETED",
                conclusion: "FAILURE",
              },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
          },
        }),
      ).toEqual({
        verdict: "FAILING",
        pendingCount: 0,
        failingNames: ["unit"],
        supersededCount: 0,
      });
    },
  );

  it("keeps a truncated failing rollup failing", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 4,
          nodes: [
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit", "+2 more contexts not shown"],
      supersededCount: 0,
    });
  });

  it("keeps cancelled attempts in failing-name output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            { kind: "CheckRun", name: "Auto response", status: "COMPLETED", conclusion: "FAILURE" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            { kind: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["lint", "unit"],
      supersededCount: 0,
    });
  });

  it("ignores superseded workflow runs while replacements are in progress", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "Real behavior proof",
              databaseId: 1_000,
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: {
                workflowRun: { databaseId: 100, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "Real behavior proof",
              databaseId: 2_000,
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: {
                workflowRun: { databaseId: 200, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: { workflowRun: { databaseId: 150, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 2, failingNames: [], supersededCount: 1 });
  });

  it("keeps only the newest same-run check attempt while its replacement is pending", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [], supersededCount: 1 });
  });

  it("accepts a successful newest check attempt when the aggregate remains failed", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 1 });
  });

  it("retains unique cancellations across independent workflows", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "old proof",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: {
                workflowRun: { databaseId: 100, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "proof",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: {
                workflowRun: { databaseId: 200, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "old CI",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 150, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 250, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["old CI", "old proof"],
      supersededCount: 0,
    });
  });

  it("preserves a genuine failure from the newest workflow run", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "older cancelled check",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 100, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["older cancelled check", "unit"],
      supersededCount: 0,
    });
  });

  it("preserves failures across interleaved distinct workflow identities", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "old deploy",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 10 } } },
            },
            {
              kind: "CheckRun",
              name: "deploy",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["old deploy", "unit"],
      supersededCount: 0,
    });
  });

  it("supersedes same-name checks across runs of the same workflow", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 1 });
  });

  it("fails conservatively when unseen contexts may explain aggregate failure", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 3,
          nodes: [
            {
              kind: "CheckRun",
              name: "CI",
              databaseId: 1_000,
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 100, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "CI",
              databaseId: 2_000,
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["status rollup", "+1 more contexts not shown"],
      supersededCount: 1,
    });
  });

  it("collects rollup contexts across pages", () => {
    const cursors: Array<string | null> = [];
    const result = collectRollupContexts((cursor) => {
      cursors.push(cursor);
      if (cursor === null) {
        return {
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              totalCount: 2,
              nodes: [{ kind: "CheckRun", name: "first" }],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            },
          },
        };
      }
      return {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            totalCount: 2,
            nodes: [{ kind: "CheckRun", name: "second" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    expect(cursors).toEqual([null, "next"]);
    expect(result?.statusCheckRollup?.contexts?.totalCount).toBe(2);
    expect(result?.statusCheckRollup?.contexts?.nodes?.map((node) => node.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects rollup pages from a changed snapshot", () => {
    expect(() =>
      collectRollupContexts((cursor) => ({
        headRefOid: "a".repeat(40),
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            totalCount: cursor === null ? 2 : 3,
            nodes: [{ kind: "CheckRun", name: cursor === null ? "first" : "second" }],
            pageInfo:
              cursor === null
                ? { hasNextPage: true, endCursor: "next" }
                : { hasNextPage: false, endCursor: null },
          },
        },
      })),
    ).toThrow("rollup snapshot changed during pagination");
  });

  it("rejects a pagination read that loses an advertised page", () => {
    expect(() =>
      collectRollupContexts((cursor) =>
        cursor === null
          ? {
              headRefOid: "a".repeat(40),
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: {
                  totalCount: 2,
                  nodes: [{ kind: "CheckRun", name: "first" }],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            }
          : { headRefOid: "b".repeat(40), statusCheckRollup: null },
      ),
    ).toThrow("rollup snapshot changed during pagination");
  });

  it("caps rollup context collection at ten pages", () => {
    let calls = 0;
    const result = collectRollupContexts(() => {
      calls += 1;
      return {
        statusCheckRollup: {
          state: "FAILURE",
          contexts: {
            totalCount: 11,
            nodes: [{ kind: "CheckRun", name: `page-${calls}` }],
            pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` },
          },
        },
      };
    });

    expect(calls).toBe(10);
    expect(result?.statusCheckRollup?.contexts?.nodes).toHaveLength(10);
  });
});
