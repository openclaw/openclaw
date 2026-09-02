import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGithubIssue,
  createGithubIssueAsync,
  createPrefilledGithubIssueUrl,
} from "./github-issue.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const authPreflightArgs = [
  "api",
  "user",
  "--hostname",
  "github.com",
  "--method",
  "GET",
  "--silent",
];
const authSuccess = {
  status: 0,
  started: true,
  stderr: Buffer.alloc(0),
  stdout: Buffer.alloc(0),
};

function afterAsyncAuth(result: {
  error?: Error;
  status: number | null;
  started?: boolean;
  stderr: Buffer;
  stdout: Buffer;
}) {
  return vi.fn().mockResolvedValueOnce(authSuccess).mockResolvedValueOnce(result);
}

function afterSyncAuth(result: {
  error?: Error;
  status: number | null;
  started?: boolean;
  stderr: Buffer;
  stdout: Buffer;
}) {
  return vi.fn().mockReturnValueOnce(authSuccess).mockReturnValueOnce(result);
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

describe("createGithubIssue", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("bounds the final encoded prefilled issue URL", () => {
    const url = createPrefilledGithubIssueUrl("Update failed 🦞", "🦞 &=?".repeat(2_000));

    expect(url.length).toBeLessThanOrEqual(16_384);
    expect(new URL(url).searchParams.get("body")).toContain("truncated for URL");
  });

  it("does not URL-encode an oversized body before truncating it", () => {
    const NativeURLSearchParams = URLSearchParams;
    let largestEncodedBody = 0;
    vi.stubGlobal(
      "URLSearchParams",
      class extends NativeURLSearchParams {
        constructor(init?: ConstructorParameters<typeof NativeURLSearchParams>[0]) {
          if (init && typeof init === "object" && !Array.isArray(init) && "body" in init) {
            largestEncodedBody = Math.max(largestEncodedBody, Buffer.byteLength(init.body, "utf8"));
          }
          super(init);
        }
      },
    );

    const url = createPrefilledGithubIssueUrl("Update failed", "sensitive".repeat(1_000_000));

    expect(url.length).toBeLessThanOrEqual(16_384);
    expect(largestEncodedBody).toBeLessThan(7_000);
  });

  it.each([
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
  ])("blocks the default async transport when %s marks a test process", async (key, value) => {
    vi.stubEnv(key, value);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    await expect(
      createGithubIssueAsync({
        body: "sanitized body",
        title: "Update failed",
        url: fallbackUrl,
      }),
    ).resolves.toEqual({
      fallbackUrl,
      issueCreateStarted: false,
      message: "External GitHub issue creation is disabled in test processes.",
      ok: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns a fallback when the async auth preflight times out", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & {
        destroy: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdin = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    child.unref = vi.fn();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    spawnMock.mockReturnValue(child);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    const result = createGithubIssueAsync({
      body: "sanitized body",
      title: "Update failed",
      url: fallbackUrl,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toEqual({
      fallbackUrl,
      issueCreateStarted: false,
      message: "GitHub CLI authentication check timed out",
      ok: false,
    });
    expect(spawnMock).toHaveBeenCalledWith("gh", authPreflightArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("settles an async issue-create timeout when process termination fails", async () => {
    vi.useFakeTimers();
    const createChild = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: EventEmitter & {
          destroy: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
        };
        stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
        kill: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      child.stdin = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
      child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      child.unref = vi.fn();
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      });
      return child;
    };
    const authChild = createChild();
    authChild.stdin.end.mockImplementation(() => {
      queueMicrotask(() => {
        authChild.emit("spawn");
        authChild.emit("close", 0);
      });
    });
    const issueChild = createChild();
    issueChild.kill = vi.fn(() => false);
    issueChild.stdin.end.mockImplementation(() => {
      queueMicrotask(() => issueChild.emit("spawn"));
    });
    spawnMock.mockReturnValueOnce(authChild).mockReturnValueOnce(issueChild);

    const result = createGithubIssueAsync({
      body: "sanitized body",
      title: "Update failed",
      url: "https://github.com/openclaw/openclaw/issues/new?title=update",
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toEqual({
      ambiguous: true,
      message: "GitHub issue creation timed out",
      ok: false,
    });
    expect(spawnMock).toHaveBeenNthCalledWith(1, "gh", authPreflightArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      "issue",
      "create",
      "--repo",
      "github.com/openclaw/openclaw",
      "--title",
      "Update failed",
      "--body-file",
      "-",
    ]);
    expect(issueChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(issueChild.stdin.destroy).toHaveBeenCalledOnce();
    expect(issueChild.stdout.destroy).toHaveBeenCalledOnce();
    expect(issueChild.stderr.destroy).toHaveBeenCalledOnce();
    expect(issueChild.unref).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "missing gh",
      result: {
        error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawn gh ENOENT",
    },
    {
      label: "unauthenticated gh",
      result: {
        status: 4,
        started: true,
        stderr: Buffer.from("To get started with GitHub CLI, run: gh auth login"),
        stdout: Buffer.alloc(0),
      },
      message: "To get started with GitHub CLI, run: gh auth login",
    },
    {
      label: "timed-out auth preflight",
      result: {
        error: Object.assign(new Error("gh auth status timed out"), { code: "ETIMEDOUT" }),
        status: null,
        started: true,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "gh auth status timed out",
    },
    {
      label: "failed auth preflight",
      result: {
        status: 2,
        started: true,
        stderr: Buffer.from("auth status unavailable"),
        stdout: Buffer.alloc(0),
      },
      message: "auth status unavailable",
    },
  ])(
    "returns a fallback when the async auth preflight reports $label",
    async ({ result, message }) => {
      const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";
      const runGh = vi.fn(async () => result);
      const afterAuthPreflight = vi.fn();
      const beforeIssueCreate = vi.fn();

      await expect(
        createGithubIssueAsync(
          { body: "sanitized body", title: "Update failed", url: fallbackUrl },
          runGh,
          { afterAuthPreflight, beforeIssueCreate },
        ),
      ).resolves.toEqual({
        fallbackUrl,
        issueCreateStarted: false,
        message,
        ok: false,
      });
      expect(runGh).toHaveBeenCalledTimes(1);
      expect(runGh).toHaveBeenCalledWith(authPreflightArgs, { input: "" });
      expect(afterAuthPreflight).toHaveBeenCalledOnce();
      expect(beforeIssueCreate).not.toHaveBeenCalled();
    },
  );

  it("uses the active-account API preflight before asynchronous issue creation", async () => {
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const runGh = afterAsyncAuth({
      status: 0,
      started: true,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(`${issueUrl}\n`),
    });

    await expect(
      createGithubIssueAsync(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        runGh,
      ),
    ).resolves.toEqual({ ok: true, url: issueUrl });
    expect(runGh).toHaveBeenNthCalledWith(1, authPreflightArgs, { input: "" });
    expect(runGh).toHaveBeenNthCalledWith(
      2,
      [
        "issue",
        "create",
        "--repo",
        "github.com/openclaw/openclaw",
        "--title",
        "Update failed",
        "--body-file",
        "-",
      ],
      { input: "sanitized body" },
    );
  });

  it("rechecks the caller guard immediately before issue creation", async () => {
    const guardError = new Error("report authority expired");
    const runGh = vi.fn().mockResolvedValueOnce(authSuccess);
    const afterAuthPreflight = vi.fn();
    const beforeIssueCreate = vi.fn(() => {
      throw guardError;
    });

    await expect(
      createGithubIssueAsync(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        runGh,
        { afterAuthPreflight, beforeIssueCreate },
      ),
    ).rejects.toBe(guardError);
    expect(afterAuthPreflight).toHaveBeenCalledOnce();
    expect(beforeIssueCreate).toHaveBeenCalledOnce();
    expect(runGh).toHaveBeenCalledOnce();
    expect(runGh).toHaveBeenCalledWith(authPreflightArgs, { input: "" });
  });

  it.each([
    {
      label: "signal",
      result: {
        status: null,
        started: true,
        stderr: Buffer.from("gh terminated by signal"),
        stdout: Buffer.alloc(0),
      },
      message: "gh terminated by signal",
    },
    {
      label: "nonzero exit",
      result: {
        status: 1,
        started: true,
        stderr: Buffer.from("post-create response failed"),
        stdout: Buffer.alloc(0),
      },
      message: "post-create response failed",
    },
    {
      label: "malformed stdout",
      result: {
        status: 0,
        started: true,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("not-an-issue-url\n"),
      },
      message: "gh completed without a validated GitHub issue URL",
    },
  ])(
    "keeps an async issue-create $label pending without a replay URL",
    async ({ result, message }) => {
      await expect(
        createGithubIssueAsync(
          {
            body: "sanitized body",
            title: "Update failed",
            url: "https://github.com/openclaw/openclaw/issues/new?title=update",
          },
          afterAsyncAuth(result),
        ),
      ).resolves.toEqual({ ambiguous: true, message, ok: false });
    },
  );

  it("accepts an async nonzero result with a validated issue URL", async () => {
    const issueUrl = "https://github.com/openclaw/openclaw/issues/789";
    await expect(
      createGithubIssueAsync(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        afterAsyncAuth({
          status: 1,
          started: true,
          stderr: Buffer.from("post-create cleanup failed"),
          stdout: Buffer.from(`${issueUrl}\n`),
        }),
      ),
    ).resolves.toEqual({ ok: true, url: issueUrl });
  });

  it.each([
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
  ])("blocks the default GitHub CLI transport when %s marks a test process", (key, value) => {
    vi.stubEnv(key, value);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: fallbackUrl,
      }),
    ).toEqual({
      fallbackUrl,
      issueCreateStarted: false,
      message: "External GitHub issue creation is disabled in test processes.",
      ok: false,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns the issue URL after a successful authenticated CLI submission", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("https://github.com/openclaw/openclaw/issues/123\n"),
    });

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: "https://github.com/openclaw/openclaw/issues/new?title=update",
      }),
    ).toEqual({ ok: true, url: "https://github.com/openclaw/openclaw/issues/123" });
    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, "gh", authPreflightArgs, {
      input: "",
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual([
      "issue",
      "create",
      "--repo",
      "github.com/openclaw/openclaw",
      "--title",
      "Update failed",
      "--body-file",
      "-",
    ]);
  });

  it("keeps a successful exit with malformed output ambiguous", () => {
    spawnSyncMock.mockReturnValueOnce(authSuccess).mockReturnValueOnce({
      status: 0,
      started: true,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("javascript:alert(1)\n"),
    });

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: "https://github.com/openclaw/openclaw/issues/new?title=update",
      }),
    ).toEqual({
      ambiguous: true,
      message: "gh completed without a validated GitHub issue URL",
      ok: false,
    });
  });

  it("accepts a validated issue URL retained alongside a later transport error", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    expect(
      createGithubIssue(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        afterSyncAuth({
          error: timeoutError,
          status: null,
          started: true,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(`${issueUrl}\n`),
        }),
      ),
    ).toEqual({ ok: true, url: issueUrl });
  });

  it("accepts a validated issue URL from a nonzero issue-create result", () => {
    const issueUrl = "https://github.com/openclaw/openclaw/issues/456";
    expect(
      createGithubIssue(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        afterSyncAuth({
          status: 1,
          started: true,
          stderr: Buffer.from("post-create cleanup failed"),
          stdout: Buffer.from(`${issueUrl}\n`),
        }),
      ),
    ).toEqual({ ok: true, url: issueUrl });
  });

  it.each([
    {
      label: "signal after spawn",
      result: {
        status: null,
        started: true,
        stderr: Buffer.from("gh terminated by signal"),
        stdout: Buffer.alloc(0),
      },
    },
    {
      label: "nonzero after create",
      result: {
        status: 1,
        started: true,
        stderr: Buffer.from("post-create response failed"),
        stdout: Buffer.alloc(0),
      },
    },
    {
      label: "post-spawn EPERM",
      result: {
        error: Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
        status: null,
        started: true,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
    },
  ])("keeps $label ambiguous without a validated issue URL", ({ result }) => {
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";
    expect(
      createGithubIssue(
        { body: "sanitized body", title: "Update failed", url: fallbackUrl },
        afterSyncAuth(result),
      ),
    ).toMatchObject({ ambiguous: true, ok: false });
  });

  it("keeps an explicit unstarted resource failure retryable without a fallback URL", () => {
    const resourceError = Object.assign(new Error("spawnSync gh EAGAIN"), { code: "EAGAIN" });
    expect(
      createGithubIssue(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        afterSyncAuth({
          error: resourceError,
          status: null,
          started: false,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
        }),
      ),
    ).toEqual({
      issueCreateStarted: false,
      message: "spawnSync gh EAGAIN",
      ok: false,
      retryable: true,
    });
  });

  it("keeps an explicit async unstarted resource failure retryable without a fallback URL", async () => {
    const resourceError = Object.assign(new Error("spawn gh EMFILE"), { code: "EMFILE" });
    await expect(
      createGithubIssueAsync(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        afterAsyncAuth({
          error: resourceError,
          status: -24,
          started: false,
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
        }),
      ),
    ).resolves.toEqual({
      issueCreateStarted: false,
      message: "spawn gh EMFILE",
      ok: false,
      retryable: true,
    });
  });

  it("bounds GitHub CLI issue creation and marks timeout as ambiguous", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    spawnSyncMock.mockReturnValueOnce(authSuccess).mockReturnValueOnce({
      error: timeoutError,
      status: null,
      started: true,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    const result = createGithubIssue({
      body: "sanitized body",
      title: "Session SQLite migration recovery report",
      url: "https://github.com/openclaw/openclaw/issues/new?title=recovery",
    });

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "gh",
      [
        "issue",
        "create",
        "--repo",
        "github.com/openclaw/openclaw",
        "--title",
        "Session SQLite migration recovery report",
        "--body-file",
        "-",
      ],
      {
        input: "sanitized body",
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(result).toEqual({
      ambiguous: true,
      message: "spawnSync gh ETIMEDOUT",
      ok: false,
    });
  });

  it.each([
    {
      label: "missing gh",
      result: {
        error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh ENOENT",
    },
    {
      label: "unexecutable gh",
      result: {
        error: Object.assign(new Error("spawnSync gh EACCES"), { code: "EACCES" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh EACCES",
    },
    {
      label: "test-blocked gh",
      result: {
        error: Object.assign(new Error("spawnSync gh EPERM"), { code: "EPERM" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh EPERM",
    },
    {
      label: "unauthenticated gh",
      result: {
        status: 4,
        started: true,
        stderr: Buffer.from("To get started with GitHub CLI, run: gh auth login"),
        stdout: Buffer.alloc(0),
      },
      message: "To get started with GitHub CLI, run: gh auth login",
    },
    {
      label: "timed-out auth preflight",
      result: {
        error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        started: true,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh ETIMEDOUT",
    },
    {
      label: "failed auth preflight",
      result: {
        status: 2,
        started: true,
        stderr: Buffer.from("auth status unavailable"),
        stdout: Buffer.alloc(0),
      },
      message: "auth status unavailable",
    },
  ])("returns a fallback when the sync auth preflight reports $label", ({ result, message }) => {
    spawnSyncMock.mockReturnValue(result);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    expect(
      createGithubIssue({ body: "sanitized body", title: "Update failed", url: fallbackUrl }),
    ).toEqual({
      fallbackUrl,
      issueCreateStarted: false,
      message,
      ok: false,
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith("gh", authPreflightArgs, {
      input: "",
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
  });
});
