import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureGit } from "./release-publish.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const sha = "a".repeat(40);
const epoch = 1_800_000_000_000;
let directory: string;
let preload: string;
let evidenceDir: string;
let sourceSha: string;
function writeFixture(file: string, value: string | Record<string, unknown>) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

beforeAll(() => {
  directory = tempDirs.make("npm-proof-gh-read-");
  writeFixture(join(directory, "package.json"), { name: "openclaw", version: "2026.10.4" });
  const git = fixtureGit(directory, "Fixture", "fixture@example.invalid");
  git("init", "--quiet");
  git("add", "package.json");
  git("commit", "--quiet", "-m", "fixture");
  sourceSha = git("rev-parse", "HEAD");
  evidenceDir = join(directory, "evidence");
  writeFixture(join(evidenceDir, "evidence.json"), "{}\n");
  preload = join(directory, "transport.mjs");
  // Exercise the real CLI, subprocess adapter, and producer checks without live GitHub or sleeps.
  writeFixture(
    preload,
    String.raw`import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const config = JSON.parse(process.env.NPM_GH_FIXTURE);
let elapsed = 0;
let calls = 0;
Date.now = () => 1800000000000 + elapsed;
Object.defineProperty(performance, 'now', { value: () => elapsed });
const record = value => appendFileSync(config.log, JSON.stringify(value) + '\n');
Atomics.wait = (_array, _index, _value, ms) => { record({wait:ms}); elapsed += ms; return 'timed-out'; };
const original = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (file !== 'gh') return original(file, args, options);
  record({args});
  const failure = config.failures[calls++];
  const headers = failure?.headers ?? {};
  const status = failure?.status ?? 200;
  const body = failure ? { message: failure.message ?? 'API rate limit exceeded for installation' } : {
    id:45, run_id:12, run_attempt:2, head_sha:'a'.repeat(40), status:'in_progress',
    name:'Check npm Plugin SDK', ...config.job,
  };
  const raw = JSON.stringify(body);
  const output = args.includes('--include') ? 'HTTP/2.0 ' + status + ' Status\r\n' + Object.entries(headers).map(([key,value]) => key + ': ' + value + '\r\n').join('') + '\r\n' + raw : raw;
  if (failure) throw Object.assign(new Error('synthetic gh failure'), {
    status:1, stdout:output, stderr:'gh: ' + body.message + ' (HTTP ' + status + ')',
  });
  return output;
};
syncBuiltinESMExports();`,
  );
});

type Failure = { status: number; headers?: Record<string, string>; message?: string };
const throttle = (headers: Record<string, string> = {}, status = 403): Failure => ({
  status,
  headers,
});
const resetHeaders = (seconds: number) => ({
  "X-RateLimit-Remaining": "0",
  "X-RateLimit-Reset": String(epoch / 1000 + seconds),
});
const retryAfter = (value: string, status = 403, message?: string): Failure => ({
  ...throttle({ "Retry-After": value }, status),
  message,
});
function runProof(failures: readonly Failure[], job: Record<string, unknown> = {}) {
  const output = join(tempDirs.make("npm-proof-output-"), "output");
  const log = output + ".requests";
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      join(process.cwd(), "scripts/npm-prepared-bundle.mjs"),
      "proof",
      ...Object.entries({
        "proof-kind": "sdk",
        "source-dir": directory,
        "input-dir": evidenceDir,
        "release-ref": sourceSha,
        "npm-dist-tag": "beta",
        "artifact-id": "78",
        "artifact-name": "openclaw-npm-sdk-proof-12-2",
        "artifact-digest": "b".repeat(64),
      }).flatMap(([key, value]) => [`--${key}`, value]),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "12",
        GITHUB_RUN_ATTEMPT: "2",
        PREFLIGHT_WORKFLOW_SHA: sha,
        PREFLIGHT_WORKFLOW_REF:
          "openclaw/openclaw/.github/workflows/full-release-artifacts.yml@refs/heads/main",
        JOB_CONTEXT: JSON.stringify({
          workflow_file_path: ".github/workflows/openclaw-npm-preflight.yml",
          workflow_repository: "openclaw/openclaw",
          workflow_sha: sha,
          check_run_id: 45,
        }),
        NPM_GH_FIXTURE: JSON.stringify({ failures, job, log }),
      },
    },
  );
  const events = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { wait?: number; args?: string[] });
  return {
    result,
    output,
    waits: events.flatMap((event) => (event.wait === undefined ? [] : [event.wait])),
    requests: events.flatMap((event) => (event.args === undefined ? [] : [event.args])),
  };
}

it.each([
  ["installation quota without headers", throttle(), [60_000]],
  ["primary quota reset", throttle(resetHeaders(3600)), [3_600_000]],
  ["429 retry-after", retryAfter("2", 429, "Too many requests"), [2000]],
  ["HTTP-date retry-after", retryAfter(new Date(epoch + 3000).toUTCString()), [3000]],
  [
    "later reset wins",
    throttle({
      "retry-after": "1",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(epoch / 1000 + 5),
    }),
    [5000],
  ],
] as const)("recovers %s before describing exact evidence", (_name, failure, waits) => {
  const proof = runProof([failure]);
  expect(proof.result.status, proof.result.stderr).toBe(0);
  expect(proof.waits).toEqual(waits);
  expect(proof.requests).toHaveLength(2);
  expect(JSON.parse(proof.result.stdout)).toMatchObject({
    source: { sha: sourceSha },
    producer: { jobId: "45", runId: "12", runAttempt: "2", workflowSha: sha },
    artifact: { id: "78", digest: "b".repeat(64) },
  });
  expect(readFileSync(proof.output, "utf8")).toContain("proof_json=");
});

it.each([
  ...[
    { status: 401, message: "Bad credentials" },
    { status: 403, message: "Resource not accessible by integration" },
    { status: 404, message: "Not Found" },
    { status: 500, message: "Internal Server Error" },
  ].map((failure) => [failure.message, [failure], [], 1, {}] as const),
  [
    "exhausted retries",
    Array.from({ length: 4 }, () => throttle()),
    [60_000, 120_000, 240_000],
    4,
    {},
  ],
  ["server delay exceeds budget", [throttle({ "retry-after": "3900" }, 429)], [], 1, {}],
  ...[{ run_attempt: 3 }, { head_sha: "c".repeat(40) }, { status: "completed" }].map(
    (job) => [JSON.stringify(job), [throttle()], [60_000], 2, job] as const,
  ),
] as const)("rejects %s without emitting evidence", (_name, failures, waits, requests, job) => {
  const proof = runProof(failures, job);
  expect(proof).toMatchObject({ result: { status: 1 }, waits });
  expect(proof.requests).toHaveLength(requests);
  expect(existsSync(proof.output)).toBe(false);
  if (Object.keys(job).length) {
    expect(proof.result.stderr).toContain("Current npm producer job identity mismatch");
  }
});
