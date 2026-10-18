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

function prepare(body: string) {
  return prepareGithubIssue({ body, title: `Support report ${body}` });
}

function cliOutput(stdout: string, status = 0) {
  return cliResult({ started: true, status, stdout: Buffer.from(stdout) });
}

function lookupResult(issue: ReturnType<typeof prepare>, url: string, body = issue.body) {
  return cliOutput(JSON.stringify([{ body, title: issue.title, url }]));
}

function childFixture() {
  return Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    kill: vi.fn(),
    unref: vi.fn(),
  });
}

function availableFallbackUrl(issue: ReturnType<typeof prepareGithubIssue>): string {
  expect(issue.browserFallback.status).toBe("available");
  if (issue.browserFallback.status !== "available") {
    throw new Error("expected an available browser fallback");
  }
  return issue.browserFallback.url;
}

function fallback(issue: ReturnType<typeof prepare>, reason: string) {
  return { reason, status: "browser-fallback", url: availableFallbackUrl(issue) };
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("does not expose raw process diagnostics through a transport failure", async () => {
  const issue = prepare("private-failure");
  const rawFailure = {
    ...cliResult({ started: true, status: 4 }),
    diagnostic: "gh auth login --with-token private-value",
  };
  const runGh = cli(rawFailure);

  const result = await submitGithubIssue(issue, runGh);

  expect(result).toEqual(fallback(issue, "authentication-unavailable"));
  expect(JSON.stringify(result)).not.toContain("private-value");
});

it("returns a typed unavailable fallback while retaining the prepared body", async () => {
  const issue = prepareGithubIssue({ body: "&=?%".repeat(5_000), title: "Sanitized report" });
  const runGh = cli(cliResult({ started: true, status: 4 }));

  await expect(submitGithubIssue(issue, runGh)).resolves.toEqual({
    cause: "authentication-unavailable",
    reason: "fallback-url-too-long",
    status: "fallback-unavailable",
  });
  expect(issue.body).toContain(`<!-- ${issue.marker} -->`);
  expect(issue.body).toContain("&=?%");
  expect(runGh).toHaveBeenCalledOnce();
});

it("uses the final HTTP response block for a definitive request rejection", async () => {
  const issue = prepare("permission-denied");
  const runGh = cli(
    authSuccess,
    cliOutput("HTTP/1.1 200 Connection established\r\n\r\nHTTP/2.0 403 Forbidden\r\n\r\n{}", 1),
  );

  await expect(submitGithubIssue(issue, runGh)).resolves.toEqual(
    fallback(issue, "transport-unavailable"),
  );
  expect(runGh).toHaveBeenCalledTimes(2);
});

it("prepares a browser fallback for a missing CLI without starting issue creation", async () => {
  const issue = prepare("missing GitHub CLI");
  const runGh = cli(cliResult({ errorCode: "ENOENT" }));

  await expect(submitGithubIssue(issue, runGh)).resolves.toEqual(
    fallback(issue, "cli-unavailable"),
  );
  expect(runGh).toHaveBeenCalledOnce();
});

it.each([false, true])("reconciles exact content (persisted attempt=%s)", async (persisted) => {
  const issue = prepare(`reconcile-${persisted}`);
  const runGh = cli(
    ...(persisted ? [] : [authSuccess, cliResult({ started: true, status: 1 })]),
    lookupResult(issue, issueUrl(456)),
  );
  await expect(
    (persisted ? reconcileGithubIssue : submitGithubIssue)(issue, runGh),
  ).resolves.toEqual(created(456));
  if (persisted) {
    expect(runGh).toHaveBeenCalledOnce();
    expect(runGh.mock.calls[0]?.[1]).toEqual({ input: "" });
    expect(runGh.mock.calls[0]?.[0][0]).toBe("issue");
    expect(runGh.mock.calls[0]?.[0]).not.toContain("api");
  } else {
    expect(runGh.mock.calls[2]?.[0]).toContain(`"${issue.marker}" in:body`);
  }
});

it.each([
  "javascript:alert(1)",
  "https://github.com.evil.example/openclaw/openclaw/issues/123",
  "https://github.com/openclaw/openclaw/issues/123?token=secret",
])("does not expose or fall back after malformed created URL %s", async (url) => {
  const issue = prepare(url);
  const runGh = cli(
    authSuccess,
    cliOutput(`HTTP/2.0 201 Created\r\n\r\n${url}\n`),
    lookupResult(issue, url),
  );

  await expect(submitGithubIssue(issue, runGh)).resolves.toEqual(unknownOutcome);
});

it("does not reconcile a marker search candidate with different content", async () => {
  const issue = prepare("marker-collision-negative");
  const runGh = cli(
    authSuccess,
    cliOutput("HTTP/2.0 201 Created\r\n\r\nnot-a-url\n"),
    lookupResult(issue, issueUrl(999), `${issue.body}\nchanged`),
  );

  await expect(submitGithubIssue(issue, runGh)).resolves.toEqual(unknownOutcome);
});

it("deduplicates concurrent submissions with the same marker", async () => {
  const issue = prepare("concurrent");
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
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("NODE_ENV", "production");
  const child = childFixture();
  child.stdin.end.mockImplementation(() => queueMicrotask(() => child.emit("spawn")));
  child.kill.mockReturnValue(false);
  spawnMock.mockReturnValue(child);
  const issue = prepare("timeout");

  const submission = submitGithubIssue(issue);
  await vi.advanceTimersByTimeAsync(30_000);

  await expect(submission).resolves.toEqual(fallback(issue, "authentication-unavailable"));
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(child.stdin.destroy).toHaveBeenCalledOnce();
  expect(child.stdout.destroy).toHaveBeenCalledOnce();
});

it.each([false, true])("checks child authority (retired=%s)", async (retire) => {
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("NODE_ENV", "production");
  let current = true;
  let claimed = false;
  let authorityAtCreate: boolean | undefined;
  spawnMock.mockImplementation((_command, args: string[]) => {
    if (args[0] === "api") {
      authorityAtCreate = current;
      expect(claimed).toBe(true);
    }
    const child = childFixture();
    child.stdin.end.mockImplementation(() =>
      queueMicrotask(() => {
        child.emit("spawn");
        if (args[0] === "api") {
          child.stdout.emit("data", Buffer.from(`${issueUrl(123)}\n`));
        }
        child.emit("close", 0);
      }),
    );
    return child;
  });
  const submission = submitGithubIssue(prepare(`final-child-${retire}`), undefined, {
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
