import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareGithubIssue,
  reconcileGithubIssue,
  submitGithubIssue,
  type RunGithubCli,
} from "./github-issue.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

const authSuccess = cliResult({ started: true, status: 0 });
const unknownOutcome = { reason: "creation-outcome-unknown", status: "outcome-unknown" };
const issueUrl = (id: number) => `https://github.com/openclaw/openclaw/issues/${id}`;
const created = (id: number) => ({ status: "created", url: issueUrl(id) });
const issue = prepareGithubIssue({ body: "sanitized report", title: "Support report" });

type CliResult = Awaited<ReturnType<RunGithubCli>>;

function cliResult(values: Partial<CliResult> = {}) {
  return { started: false, status: null, stdout: Buffer.alloc(0), ...values };
}

function cli(...results: (CliResult | Promise<CliResult>)[]) {
  const run = vi.fn<RunGithubCli>();
  for (const result of results) {
    run.mockReturnValueOnce(Promise.resolve(result));
  }
  return run;
}

function cliOutput(stdout: string, status = 0) {
  return cliResult({ started: true, status, stdout: Buffer.from(stdout) });
}

function lookupResult(url: string, body = issue.body) {
  return cliOutput(JSON.stringify([{ body, title: issue.title, url }]));
}

function childFixture(output?: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.emit("spawn");
      if (output !== undefined) {
        child.stdout.emit("data", Buffer.from(output));
        child.emit("close", 0);
      }
    }),
  );
  return child;
}

function fallback(reason: string) {
  assert(issue.browserFallback.status === "available");
  return { reason, status: "browser-fallback", url: issue.browserFallback.url };
}

function enableChildProcess() {
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("NODE_ENV", "production");
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("does not expose authentication diagnostics or start creation after denial", async () => {
  const denied = { ...cliResult({ started: true, status: 4 }), diagnostic: "private-value" };
  const runGh = cli(denied);
  expect(await submitGithubIssue(issue, runGh)).toEqual(fallback("authentication-unavailable"));
  expect(runGh).toHaveBeenCalledOnce();
});

it("returns a typed unavailable fallback while retaining the prepared body", async () => {
  const large = prepareGithubIssue({ body: "&=?%".repeat(5_000), title: "Sanitized report" });
  const runGh = cli(cliResult({ started: true, status: 4 }));

  await expect(submitGithubIssue(large, runGh)).resolves.toEqual({
    cause: "authentication-unavailable",
    reason: "fallback-url-too-long",
    status: "fallback-unavailable",
  });
  expect(large.body).toContain(`<!-- ${large.marker} -->`);
  expect(large.body).toContain("&=?%");
  expect(runGh).toHaveBeenCalledOnce();
});

it("reconciles a persisted attempt without creating another issue", async () => {
  const runGh = cli(lookupResult(issueUrl(456)));
  await expect(reconcileGithubIssue(issue, runGh)).resolves.toEqual(created(456));
  expect(runGh.mock.calls[0]?.[0]).not.toContain("api");
});

const rejected = "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2.0 403 Forbidden\r\n\r\n{}";
const malformedUrls = [
  "javascript:alert(1)",
  "https://github.com.evil.example/openclaw/openclaw/issues/123",
  "https://github.com/openclaw/openclaw/issues/123?token=secret",
];
it.each([
  ["HTTP rejection", cliOutput(rejected, 1), undefined, fallback("transport-unavailable")],
  [
    "lost response",
    cliResult({ started: true, status: 1 }),
    lookupResult(issueUrl(456)),
    created(456),
  ],
  [
    "changed content",
    cliOutput("not-a-url"),
    lookupResult(issueUrl(999), `${issue.body}\nchanged`),
    unknownOutcome,
  ],
  ...malformedUrls.map(
    (url) =>
      [
        url,
        cliOutput(`HTTP/2.0 201 Created\r\n\r\n${url}\n`),
        lookupResult(url),
        unknownOutcome,
      ] as const,
  ),
] as const)("settles creation safely after %s", async (_name, response, lookup, expected) => {
  const runGh = cli(authSuccess, response, ...(lookup ? [lookup] : []));
  await expect(submitGithubIssue(issue, runGh)).resolves.toEqual(expected);
  expect(runGh).toHaveBeenCalledTimes(lookup ? 3 : 2);
  if (lookup) {
    expect(runGh.mock.calls[2]?.[0]).toContain(`"${issue.marker}" in:body`);
  }
});

it("deduplicates concurrent submissions with the same marker", async () => {
  const { promise: auth, resolve: releaseAuth } = createDeferred<ReturnType<typeof cliResult>>();
  const runGh = cli(auth, cliOutput(`${issueUrl(789)}\n`));

  const first = submitGithubIssue(issue, runGh);
  const second = submitGithubIssue(issue, runGh);
  expect(first).toBe(second);
  expect(runGh).toHaveBeenCalledOnce();
  releaseAuth?.(authSuccess);

  await expect(Promise.all([first, second])).resolves.toEqual([created(789), created(789)]);
  expect(runGh).toHaveBeenCalledTimes(2);
});

it("bounds a stalled authentication preflight without exposing process diagnostics", async () => {
  vi.useFakeTimers();
  enableChildProcess();
  const child = childFixture();
  child.kill.mockReturnValue(false);
  spawnMock.mockReturnValue(child);

  const submission = submitGithubIssue(issue);
  await vi.advanceTimersByTimeAsync(30_000);

  await expect(submission).resolves.toEqual(fallback("authentication-unavailable"));
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(child.stdin.destroy).toHaveBeenCalledOnce();
  expect(child.stdout.destroy).toHaveBeenCalledOnce();
});

it.each([false, true])("checks child authority (retired=%s)", async (retire) => {
  enableChildProcess();
  let current = true;
  let claimed = false;
  let authorityAtCreate: boolean | undefined;
  spawnMock.mockImplementation((_command, args: string[]) => {
    if (args[0] === "api") {
      authorityAtCreate = current;
      expect(claimed).toBe(true);
    }
    return childFixture(args[0] === "api" ? `${issueUrl(123)}\n` : "");
  });
  const submission = submitGithubIssue(issue, undefined, {
    beforeIssueCreate: async () => {
      if (retire) {
        queueMicrotask(() => {
          current = false;
        });
      }
      return (): undefined => {
        if (!current) {
          throw new Error("authority retired");
        }
        claimed = true;
        queueMicrotask(() => {
          current = false;
        });
      };
    },
  });
  if (retire) {
    await expect(submission).rejects.toThrow("authority retired");
    expect(claimed).toBe(false);
    expect(authorityAtCreate).toBeUndefined();
  } else {
    await expect(submission).resolves.toEqual(created(123));
    expect(authorityAtCreate).toBe(true);
  }
  expect(spawnMock.mock.calls.map(([, args]) => args[0])).toEqual(
    retire ? ["auth"] : ["auth", "api"],
  );
});
