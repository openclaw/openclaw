import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnWithFallbackMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  child.kill = killMock as ChildProcess["kill"];
  return { child, killMock };
}

async function createAdapterHarness(params?: {
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { child, killMock } = createStubChild(params?.pid);
  spawnWithFallbackMock.mockResolvedValue({
    child,
    usedFallback: false,
  });
  const adapter = await createChildAdapter({
    argv: params?.argv ?? ["node", "-e", "setTimeout(() => {}, 1000)"],
    env: params?.env,
    stdinMode: "pipe-open",
  });
  return { adapter, killMock };
}

describe("createChildAdapter", () => {
  const originalServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;

  beforeAll(async () => {
    ({ createChildAdapter } = await import("./child.js"));
  });

  beforeEach(() => {
    spawnWithFallbackMock.mockClear();
    killProcessTreeMock.mockClear();
    delete process.env.OPENCLAW_SERVICE_MARKER;
  });

  afterAll(() => {
    if (originalServiceMarker === undefined) {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    } else {
      process.env.OPENCLAW_SERVICE_MARKER = originalServiceMarker;
    }
  });

  it("uses process-tree kill for default SIGKILL", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 4321 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    // On Windows, detached defaults to false (headless Scheduled Task compat);
    // on POSIX, detached is true with a no-detach fallback.
    if (process.platform === "win32") {
      expect(spawnArgs.options?.detached).toBe(false);
      expect(spawnArgs.fallbacks).toEqual([]);
    } else {
      expect(spawnArgs.options?.detached).toBe(true);
      expect(spawnArgs.fallbacks?.[0]?.options?.detached).toBe(false);
    }

    adapter.kill();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321);
    expect(killMock).not.toHaveBeenCalled();
  });

  it("uses direct child.kill for non-SIGKILL signals", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGTERM");

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
  });

  it("disables detached mode in service-managed runtime", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";

    await createAdapterHarness({ pid: 7777 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.fallbacks ?? []).toEqual([]);
  });

  it("keeps inherited env when no override env is provided", async () => {
    await createAdapterHarness({
      pid: 3333,
      argv: ["node", "-e", "process.exit(0)"],
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: NodeJS.ProcessEnv };
    };
    expect(spawnArgs.options?.env).toBeUndefined();
  });

  it("passes explicit env overrides as strings", async () => {
    await createAdapterHarness({
      pid: 4444,
      argv: ["node", "-e", "process.exit(0)"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: Record<string, string> };
    };
    expect(spawnArgs.options?.env).toEqual({ FOO: "bar", COUNT: "12" });
  });

  it("decodes multi-byte UTF-8 characters split across stdout chunks", async () => {
    const { child } = createStubChild(5555);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "''"],
      stdinMode: "pipe-open",
    });

    const chunks: string[] = [];
    adapter.onStdout((chunk) => chunks.push(chunk));

    // "你好" in UTF-8 is 6 bytes: e4 bd a0 e5 a5 bd
    // Split the first character across two Buffer chunks to simulate
    // a multi-byte boundary split that causes mojibake without StringDecoder.
    const fullBytes = Buffer.from("你好", "utf8"); // [e4, bd, a0, e5, a5, bd]
    const part1 = fullBytes.subarray(0, 2); // [e4, bd] — incomplete first char
    const part2 = fullBytes.subarray(2); // [a0, e5, a5, bd] — rest

    child.stdout!.emit("data", part1);
    child.stdout!.emit("data", part2);
    child.stdout!.emit("end");

    const result = chunks.join("");
    expect(result).toBe("你好");
  });

  it("decodes multi-byte UTF-8 characters split across stderr chunks", async () => {
    const { child } = createStubChild(6666);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "''"],
      stdinMode: "pipe-open",
    });

    const chunks: string[] = [];
    adapter.onStderr((chunk) => chunks.push(chunk));

    // "中文" in UTF-8 is 6 bytes: e4 b8 ad e6 96 87
    // Split in the middle of the second character.
    const fullBytes = Buffer.from("中文", "utf8");
    const part1 = fullBytes.subarray(0, 4); // first char + 1 byte of second
    const part2 = fullBytes.subarray(4); // remaining 2 bytes of second char

    child.stderr!.emit("data", part1);
    child.stderr!.emit("data", part2);
    child.stderr!.emit("end");

    const result = chunks.join("");
    expect(result).toBe("中文");
  });
});
