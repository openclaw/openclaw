import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let execGhReadAsync: typeof import("../../scripts/lib/plain-gh.mjs").execGhReadAsync;
let execPlainGhAsync: typeof import("../../scripts/lib/plain-gh.mjs").execPlainGhAsync;
let execPrGhAsync: typeof import("../../scripts/pr-lib/github.mjs").execPrGhAsync;

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: transport.spawn,
}));

type Request = {
  args: string[];
  options: { stdio: unknown[] };
  child: ReturnType<typeof makeChild>;
};
let requests: Request[];
const env = { PATH: "/fixture", OPENCLAW_GH_BIN: process.execPath, GH_TOKEN: "fixture-token" };
const notifiedEnv = { ...env, OPENCLAW_PR_LOCK_NOTIFY_FD: "3" };
function makeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
}

beforeEach(async () => {
  vi.resetModules();
  ({ execGhReadAsync, execPlainGhAsync } = await import("../../scripts/lib/plain-gh.mjs"));
  ({ execPrGhAsync } = await import("../../scripts/pr-lib/github.mjs"));
  requests = [];
  transport.spawn.mockImplementation((_file, args, options) => {
    const child = makeChild();
    requests.push({ args, options, child });
    return child;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const requestAt = (index: number) => expectDefined(requests[index], `spawned request ${index}`);
const drained = { stdout: { destroyed: true }, stderr: { destroyed: true } };

function complete(request: Request, code = 0, stdout = "ok", stderr = "") {
  request.child.stdout.end(stdout);
  request.child.stderr.end(stderr);
  request.child.emit("close", code, null);
}

function completeBatch(start: number, end = requests.length) {
  requests.slice(start, end).forEach((request) => complete(request));
}

function startInput(options: Parameters<typeof execPrGhAsync>[1]) {
  const task = execPrGhAsync(["api", "graphql", "--input", "-"], options, "plain");
  const request = requestAt(0);
  const inputPath = request.args[request.args.indexOf("--input") + 1];
  if (!inputPath) {
    throw new Error("Expected staged input path");
  }
  return { task, request, inputPath };
}

it("caps mixed writer and reader subprocesses at four and drains queued work", async () => {
  const tasks = Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? execGhReadAsync : execPlainGhAsync)([String(index)], { env }),
  );
  expect(requests).toHaveLength(4);
  completeBatch(0, 4);
  await Promise.all(tasks.slice(0, 4));
  expect(requests).toHaveLength(8);
  completeBatch(4, 8);
  await Promise.all(tasks.slice(4, 8));
  expect(requests).toHaveLength(10);
  completeBatch(8);
  await expect(Promise.all(tasks)).resolves.toEqual(Array(10).fill("ok"));
});

it("keeps the writer notifier and quota refusal semantics without retrying", async () => {
  const task = execPrGhAsync(
    ["api", "repos/fixture/repo", "--include"],
    { env: notifiedEnv },
    "plain",
  );
  expect(requestAt(0).options.stdio).toEqual(["ignore", "pipe", "pipe", 3]);
  complete(
    requestAt(0),
    1,
    'HTTP/2.0 403 Forbidden\r\nx-ratelimit-resource: core\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: 2000000000\r\n\r\n{"message":"API rate limit exceeded"}',
  );
  await expect(task).rejects.toMatchObject({
    code: "OPENCLAW_GH_ACCESS",
    status: 75,
    coreQuotaExhausted: true,
  });
  expect(requests).toHaveLength(1);
});

it.each([false, true])(
  "joins overflow before refusing work (granted waiter=%s)",
  async (granted) => {
    vi.useFakeTimers();
    const tasks = Array.from({ length: 5 }, () => execGhReadAsync(["api"], { env, maxBuffer: 3 }));
    const index = granted ? 1 : 0;
    const request = requestAt(index);
    const failure = expect(tasks[index]).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      ...(granted ? {} : { processTreeState: "indeterminate" }),
    });
    const queued = expect(tasks[4]).rejects.toMatchObject({ code: "OPENCLAW_GH_UNJOINED" });
    request.child.stdout.write("too large");
    if (granted) {
      complete(requestAt(0));
      await Promise.resolve();
      vi.advanceTimersByTime(1_000);
    } else {
      expect(request.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(request.child.stdout.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.child).toMatchObject(drained);
      expect(requests).toHaveLength(4);
    }
    request.child.emit("close", null, "SIGTERM");
    await Promise.all([failure, queued]);
    expect(requests).toHaveLength(4);
    completeBatch(granted ? 2 : 1);
    await expect(Promise.all(tasks.slice(0, 4).filter((_, i) => i !== index))).resolves.toEqual(
      Array(3).fill("ok"),
    );
    if (!granted) {
      await expect(execGhReadAsync(["api"], { env })).rejects.toMatchObject({
        code: "OPENCLAW_GH_UNJOINED",
      });
      expect(requests).toHaveLength(4);
    }
  },
);

it.each([false, true])(
  "times out through child drainage (inherited output=%s)",
  async (inherited) => {
    vi.useFakeTimers();
    const { task, request, inputPath } = startInput({
      env: notifiedEnv,
      input: "private bytes",
      timeout: 100,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(readFileSync(inputPath, "utf8")).toBe("private bytes");
    const failure = task.catch((error: unknown) => error);
    let settled = false;
    void task.catch(() => {
      settled = true;
    });
    if (inherited) {
      request.child.emit("exit", 0, null);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(request.child.stdout.destroyed).toBe(false);
    expect(request.options.stdio).toEqual(["ignore", "pipe", "pipe", 3]);
    if (inherited) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.child).toMatchObject(drained);
      expect(settled).toBe(false);
      request.child.emit("close", 0, null);
      expect(await failure).toMatchObject({ code: "ETIMEDOUT", processTreeState: "indeterminate" });
      expect(readFileSync(inputPath, "utf8")).toBe("private bytes");
      rmSync(dirname(inputPath), { recursive: true });
    } else {
      expect(request.child.kill).toHaveBeenCalledWith("SIGTERM");
      complete(request, 1);
      const error = await failure;
      expect(error).toMatchObject({ code: "ETIMEDOUT" });
      expect(error).not.toHaveProperty("processTreeState");
      expect(existsSync(inputPath)).toBe(false);
      const retry = execGhReadAsync(["api"], { env });
      expect(requests).toHaveLength(2);
      complete(requestAt(1));
      await expect(retry).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(1_000);
    }
  },
);
