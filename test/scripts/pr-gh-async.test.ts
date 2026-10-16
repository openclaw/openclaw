import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
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
  file: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv; stdio: unknown[] };
  child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
};
let requests: Request[];
const env = { PATH: "/fixture", OPENCLAW_GH_BIN: process.execPath, GH_TOKEN: "fixture-token" };

beforeEach(async () => {
  vi.resetModules();
  ({ execGhReadAsync, execPlainGhAsync } = await import("../../scripts/lib/plain-gh.mjs"));
  ({ execPrGhAsync } = await import("../../scripts/pr-lib/github.mjs"));
  requests = [];
  transport.spawn.mockImplementation((file, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
    });
    requests.push({ file, args, options, child });
    return child;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function requestAt(index: number): Request {
  const request = requests[index];
  if (!request) {
    throw new Error(`Expected spawned request ${index}`);
  }
  return request;
}

function complete(request: Request, code = 0, stdout = "ok", stderr = "") {
  request.child.stdout.end(stdout);
  request.child.stderr.end(stderr);
  request.child.emit("close", code, null);
}

it("caps mixed writer and reader subprocesses at four and drains queued work", async () => {
  const tasks = Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? execGhReadAsync : execPlainGhAsync)([String(index)], { env }),
  );
  expect(requests).toHaveLength(4);
  expect(requests.map((request) => request.file)).toEqual([
    process.execPath,
    "gh",
    process.execPath,
    "gh",
  ]);
  expect(requestAt(0).options.env.OPENCLAW_GH_BIN).toBe(process.execPath);
  expect(requestAt(1).options.env.OPENCLAW_GH_BIN).toBeUndefined();
  for (const request of requests.slice(0, 4)) {
    complete(request);
  }
  await Promise.all(tasks.slice(0, 4));
  expect(requests).toHaveLength(8);
  for (const request of requests.slice(4, 8)) {
    complete(request);
  }
  await Promise.all(tasks.slice(4, 8));
  expect(requests).toHaveLength(10);
  for (const request of requests.slice(8)) {
    complete(request);
  }
  await expect(Promise.all(tasks)).resolves.toEqual(Array(10).fill("ok"));
});

it("keeps the writer notifier and quota refusal semantics without retrying", async () => {
  const task = execPrGhAsync(
    ["api", "repos/fixture/repo", "--include"],
    {
      env: { ...env, OPENCLAW_PR_LOCK_NOTIFY_FD: "3" },
    },
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

it("keeps input bytes private until the asynchronous child has closed", async () => {
  const task = execPrGhAsync(
    ["api", "graphql", "--input", "-"],
    {
      env,
      input: "fixture payload",
      stdio: ["pipe", "pipe", "pipe"],
    },
    "plain",
  );
  const request = requestAt(0);
  const path = request.args[request.args.indexOf("--input") + 1];
  if (!path) {
    throw new Error("Expected staged input path");
  }
  expect(readFileSync(path, "utf8")).toBe("fixture payload");
  expect(request.options.stdio[0]).toBe("ignore");
  complete(request);
  await expect(task).resolves.toBe("ok");
  expect(existsSync(path)).toBe(false);
});

it("joins a failed direct child and refuses queued or later work when output is cut", async () => {
  vi.useFakeTimers();
  const tasks = Array.from({ length: 5 }, () => execGhReadAsync(["api"], { env, maxBuffer: 3 }));
  const first = requestAt(0);
  const failure = expect(tasks[0]).rejects.toMatchObject({
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    processTreeState: "indeterminate",
  });
  const queued = expect(tasks[4]).rejects.toMatchObject({ code: "OPENCLAW_GH_UNJOINED" });
  first.child.stdout.write("too large");
  expect(first.child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(first.child.stdout.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.child.stdout.destroyed).toBe(true);
  expect(first.child.stderr.destroyed).toBe(true);
  expect(requests).toHaveLength(4);
  first.child.emit("close", null, "SIGTERM");
  await Promise.all([failure, queued]);
  expect(requests).toHaveLength(4);
  for (const request of requests.slice(1)) {
    complete(request);
  }
  await expect(Promise.all(tasks.slice(1, 4))).resolves.toEqual(Array(3).fill("ok"));
  await expect(execGhReadAsync(["api"], { env })).rejects.toMatchObject({
    code: "OPENCLAW_GH_UNJOINED",
  });
  expect(requests).toHaveLength(4);
});

it("allows retry after a timed-out child closes naturally within its drain grace", async () => {
  vi.useFakeTimers();
  const task = execPrGhAsync(
    ["api", "graphql", "--input", "-"],
    { env: { ...env, OPENCLAW_PR_LOCK_NOTIFY_FD: "3" }, input: "private bytes", timeout: 100 },
    "plain",
  );
  const failure = task.catch((error: unknown) => error);
  const request = requestAt(0);
  const inputPath = request.args[request.args.indexOf("--input") + 1]!;
  await vi.advanceTimersByTimeAsync(100);
  expect(request.child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(request.child.stdout.destroyed).toBe(false);
  expect(request.options.stdio).toEqual(["ignore", "pipe", "pipe", 3]);
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
});

it("enforces timeout across inherited output while preserving notifier and private input", async () => {
  vi.useFakeTimers();
  const task = execPrGhAsync(
    ["api", "graphql", "--input", "-"],
    { env: { ...env, OPENCLAW_PR_LOCK_NOTIFY_FD: "3" }, input: "private bytes", timeout: 100 },
    "plain",
  );
  const request = requestAt(0);
  const inputPath = request.args[request.args.indexOf("--input") + 1]!;
  const failure = expect(task).rejects.toMatchObject({
    code: "ETIMEDOUT",
    processTreeState: "indeterminate",
  });
  let settled = false;
  void task.catch(() => {
    settled = true;
  });
  request.child.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(100);
  expect(request.child.stdout.destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(request.child.stdout.destroyed).toBe(true);
  expect(request.child.stderr.destroyed).toBe(true);
  expect(request.options.stdio).toEqual(["ignore", "pipe", "pipe", 3]);
  expect(settled).toBe(false);
  request.child.emit("close", 0, null);
  await failure;
  expect(readFileSync(inputPath, "utf8")).toBe("private bytes");
  rmSync(dirname(inputPath), { recursive: true });
});

it("refuses a granted waiter when another child fails before the waiter can spawn", async () => {
  vi.useFakeTimers();
  const tasks = Array.from({ length: 5 }, () => execGhReadAsync(["api"], { env, maxBuffer: 3 }));
  const failed = expect(tasks[1]).rejects.toMatchObject({
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
  const queued = expect(tasks[4]).rejects.toMatchObject({ code: "OPENCLAW_GH_UNJOINED" });
  requestAt(1).child.stdout.write("too large");
  complete(requestAt(0));
  await Promise.resolve();
  vi.advanceTimersByTime(1_000);
  requestAt(1).child.emit("close", null, "SIGTERM");
  await Promise.all([failed, queued]);
  expect(requests).toHaveLength(4);
  complete(requestAt(2));
  complete(requestAt(3));
  await Promise.all([tasks[0], tasks[2], tasks[3]]);
});
