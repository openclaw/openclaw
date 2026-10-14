import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const sha = "a".repeat(40);
const epoch = 1_800_000_000_000;
let directory: string;
let preload: string;
let evidenceDir: string;
let sourceSha: string;

beforeAll(() => {
  directory = tempDirs.make("npm-proof-gh-read-");
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.10.4" }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", "package.json");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  sourceSha = git("rev-parse", "HEAD");
  evidenceDir = join(directory, "evidence");
  mkdirSync(evidenceDir);
  writeFileSync(join(evidenceDir, "evidence.json"), "{}\n");
  preload = join(directory, "transport.mjs");
  // Exercise the real CLI, subprocess adapter, and producer checks without live GitHub or sleeps.
  writeFileSync(
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
function runProof(failures: Failure[], job: Record<string, unknown> = {}) {
  const output = join(tempDirs.make("npm-proof-output-"), "output");
  const log = output + ".requests";
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      join(process.cwd(), "scripts/npm-prepared-bundle.mjs"),
      "proof",
      "--proof-kind",
      "sdk",
      "--source-dir",
      directory,
      "--input-dir",
      evidenceDir,
      "--release-ref",
      sourceSha,
      "--npm-dist-tag",
      "beta",
      "--artifact-id",
      "78",
      "--artifact-name",
      "openclaw-npm-sdk-proof-12-2",
      "--artifact-digest",
      "b".repeat(64),
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

describe("npm current-producer metadata recovery", () => {
  it.each([
    ["installation quota without headers", { status: 403 }, [60_000]],
    [
      "primary quota reset",
      {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(epoch / 1000 + 3600) },
      },
      [3_600_000],
    ],
    [
      "429 retry-after",
      { status: 429, headers: { "Retry-After": "2" }, message: "Too many requests" },
      [2000],
    ],
    [
      "HTTP-date retry-after",
      { status: 403, headers: { "Retry-After": new Date(epoch + 3000).toUTCString() } },
      [3000],
    ],
    [
      "later reset wins",
      {
        status: 403,
        headers: {
          "retry-after": "1",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(epoch / 1000 + 5),
        },
      },
      [5000],
    ],
  ] as const)("recovers %s before describing exact evidence", (_name, failure, waits) => {
    const proof = runProof([failure]);
    expect(proof.result.status, proof.result.stderr).toBe(0);
    expect(proof.waits).toEqual(waits);
    expect(proof.requests).toHaveLength(2);
    const result = JSON.parse(proof.result.stdout);
    expect(result.source.sha).toBe(sourceSha);
    expect(result.producer).toMatchObject({
      jobId: "45",
      runId: "12",
      runAttempt: "2",
      workflowSha: sha,
    });
    expect(result.artifact).toMatchObject({ id: "78", digest: "b".repeat(64) });
    expect(readFileSync(proof.output, "utf8")).toContain("proof_json=");
  });

  it.each([
    { status: 401, message: "Bad credentials" },
    { status: 403, message: "Resource not accessible by integration" },
    { status: 404, message: "Not Found" },
    { status: 500, message: "Internal Server Error" },
  ])("does not retry HTTP $status permission/non-throttle failures", (failure) => {
    const proof = runProof([failure]);
    expect(proof.result.status).toBe(1);
    expect(proof.waits).toEqual([]);
    expect(proof.requests).toHaveLength(1);
    expect(existsSync(proof.output)).toBe(false);
  });

  it("bounds repeated throttle recovery and never emits evidence on exhaustion", () => {
    const proof = runProof(Array.from({ length: 4 }, () => ({ status: 403 })));
    expect(proof.result.status).toBe(1);
    expect(proof.waits).toEqual([60_000, 120_000, 240_000]);
    expect(proof.requests).toHaveLength(4);
    expect(existsSync(proof.output)).toBe(false);
  });

  it("refuses a server delay outside the recovery budget without retrying early", () => {
    const proof = runProof([{ status: 429, headers: { "retry-after": "3900" } }]);
    expect(proof.result.status).toBe(1);
    expect(proof.waits).toEqual([]);
    expect(proof.requests).toHaveLength(1);
    expect(existsSync(proof.output)).toBe(false);
  });

  it.each([{ run_attempt: 3 }, { head_sha: "c".repeat(40) }, { status: "completed" }])(
    "rejects changed producer identity after waiting: %j",
    (job) => {
      const proof = runProof([{ status: 403 }], job);
      expect(proof.result.status).toBe(1);
      expect(proof.result.stderr).toContain("Current npm producer job identity mismatch");
      expect(proof.waits).toEqual([60_000]);
      expect(existsSync(proof.output)).toBe(false);
    },
  );
});
