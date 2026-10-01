import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fileLocks from "@openclaw/fs-safe/file-lock";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunManagedCommandOptions } from "../../scripts/lib/managed-child-process.mts";
import { runSemanticCheck } from "../../scripts/lib/semantic-check-admission.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), memory: vi.fn() }));
vi.mock("@openclaw/fs-safe/file-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/file-lock")>()),
  acquireFileLock: vi.fn(),
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: mocks.run,
}));
vi.mock("../../scripts/lib/process-memory.mts", () => ({
  readProcessMemoryCapacity: mocks.memory,
}));
const actual = await vi.importActual<typeof import("@openclaw/fs-safe/file-lock")>(
  "@openclaw/fs-safe/file-lock",
);
const lifetime = createFixtureLifetime();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const held: fileLocks.FileLockHandle[] = [];
let directory: string;
let lockPath: string;
const scope = "openclaw-check-fixture.scope";
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const home = fs.realpathSync(lifetime.createTempDir("semantic-admission-"));
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  directory = path.join(home, ".cache/openclaw/semantic-checks");
  lockPath = path.join(directory, `${os.hostname()}.lock`);
  mocks.memory.mockReset().mockReturnValue({
    capacityBytes: 32 * 1024 ** 3,
    limitBytes: 24 * 1024 ** 3,
    availableBytes: 24 * 1024 ** 3,
    usageKnown: true,
  });
  mocks.run.mockReset().mockImplementation(async (options: RunManagedCommandOptions) => {
    options.onMemoryScope?.(scope);
    return 0;
  });
  vi.mocked(fileLocks.acquireFileLock)
    .mockReset()
    .mockImplementation(async (...args) => {
      const lock = await actual.acquireFileLock(...args);
      held.push(lock);
      return lock;
    });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  // Retention tests simulate uncertain work; their fixture has no live process.
  for (const lock of held.splice(0)) {
    await lock.release();
  }
  await lifetime.cleanup();
});

function waitForContention() {
  const waiting = createDeferred();
  vi.mocked(console.error).mockImplementation((message: string) => {
    if (message.includes("waiting for the host")) {
      waiting.resolve();
    }
  });
  return waiting.promise;
}

it("serializes independent worktrees despite task-specific HOME and TMPDIR", async () => {
  const ready = createDeferred();
  const release = createDeferred<number>();
  mocks.run.mockImplementationOnce(() => {
    ready.resolve();
    return release.promise;
  });
  const first = runSemanticCheck({
    bin: "first",
    cwd: "/workspace/first",
    env: { HOME: "/first", TMPDIR: "/first/tmp" },
  });
  await ready.promise;
  const waiting = waitForContention();
  const second = runSemanticCheck({
    bin: "second",
    cwd: "/workspace/second",
    env: { HOME: "/second", TMPDIR: "/second/tmp" },
  });
  try {
    await waiting;
    expect(mocks.run).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(0);
    expect(await Promise.all([first, second])).toEqual([0, 0]);
  }
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("joins cancellation of a contended waiter without disturbing live ownership", async () => {
  const ready = createDeferred();
  const release = createDeferred<number>();
  mocks.run.mockImplementationOnce(() => {
    ready.resolve();
    return release.promise;
  });
  const first = runSemanticCheck({ bin: "first" });
  await ready.promise;
  const owner = fs.readFileSync(lockPath, "utf8");
  const waiting = waitForContention();
  const controller = new AbortController();
  const queued = runSemanticCheck({ bin: "canceled", signal: controller.signal }).catch(
    (error: unknown) => error,
  );
  try {
    await waiting;
    controller.abort();
    expect(await queued).toBe(controller.signal.reason);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    release.resolve(0);
    await Promise.all([first, queued]);
  }
});

it.for([false, true])(
  "charges queue time and rereads memory after acquisition; expires=$0",
  async (expires) => {
    const ready = createDeferred();
    const release = createDeferred<number>();
    mocks.run.mockImplementationOnce(() => {
      ready.resolve();
      return release.promise;
    });
    const first = runSemanticCheck({ bin: "first" });
    await ready.promise;
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const waiting = waitForContention();
    const second = runSemanticCheck({ bin: "second", timeoutMs: 60_000 });
    await waiting;
    mocks.memory.mockReturnValue({
      capacityBytes: 8 * 1024 ** 3,
      limitBytes: 4 * 1024 ** 3,
      availableBytes: 4 * 1024 ** 3,
      usageKnown: true,
    });
    now += expires ? 61_000 : 40_000;
    release.resolve(0);
    expect(await Promise.all([first, second])).toEqual([0, expires ? 75 : 0]);
    if (expires) {
      expect(mocks.run).toHaveBeenCalledTimes(1);
    } else {
      expect(mocks.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeoutMs: 20_000, memoryLimitBytes: 2 * 1024 ** 3 }),
      );
    }
  },
);

it.each([
  [8, 6, 3],
  [16, 10, 5],
  [32, 24, 8],
  [128, 96, 8],
  [32, 2, 1],
])("caps a %s GiB host with %s GiB headroom at %s GiB", async (capacity, headroom, expected) => {
  mocks.memory.mockReturnValue({
    capacityBytes: capacity * 1024 ** 3,
    limitBytes: headroom * 1024 ** 3,
    availableBytes: headroom * 1024 ** 3,
    usageKnown: true,
  });
  await runSemanticCheck({ bin: "fixture" });
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({ memoryLimitBytes: expected * 1024 ** 3 }),
  );
});

it.each([null, 512 * 1024 ** 2])(
  "refuses unknown or insufficient headroom: %s",
  async (headroom) => {
    mocks.memory.mockReturnValue({
      capacityBytes: 8 * 1024 ** 3,
      limitBytes: headroom,
      availableBytes: headroom,
      usageKnown: true,
    });
    expect(await runSemanticCheck({ bin: "fixture" })).toBe(75);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  },
);

it.each([
  { availableBytes: null, usageKnown: true },
  { availableBytes: 24 * 1024 ** 3, usageKnown: false },
])("refuses a capacity fallback without observed headroom: %j", async (observation) => {
  mocks.memory.mockReturnValue({
    capacityBytes: 32 * 1024 ** 3,
    limitBytes: 24 * 1024 ** 3,
    ...observation,
  });
  expect(await runSemanticCheck({ bin: "fixture" })).toBe(75);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("preserves the caller's Go policy and records scope identity before launch", async () => {
  const env = { GOMAXPROCS: "4", GOGC: "100", GOMEMLIMIT: "1GiB" };
  const observe = vi.fn((unit: string) => {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { scopeReceipt: string };
    expect(fs.readFileSync(path.join(directory, owner.scopeReceipt), "utf8")).toBe(unit + "\n");
  });
  await runSemanticCheck({ bin: "fixture", env, onMemoryScope: observe });
  expect(observe).toHaveBeenCalledExactlyOnceWith(scope);
  expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ env }));
  expect(fs.readdirSync(directory)).toEqual([]);
});

it.each(["live", "indeterminate"])(
  "retains the exact scope receipt after %s cleanup",
  async (processTreeState) => {
    const failure = Object.assign(new Error("cleanup failed"), { processTreeState });
    mocks.run.mockImplementationOnce(async (options: RunManagedCommandOptions) => {
      options.onMemoryScope?.(scope);
      throw failure;
    });
    await expect(runSemanticCheck({ bin: "fixture" })).rejects.toBe(failure);
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid: number;
      scopeReceipt: string;
    };
    expect(owner.pid).toBe(process.pid);
    expect(fs.readFileSync(path.join(directory, owner.scopeReceipt), "utf8")).toBe(scope + "\n");
  },
);

it("retains the receipt when lock release fails", async () => {
  const failure = new Error("release failed");
  const acquire = vi.mocked(fileLocks.acquireFileLock).getMockImplementation()!;
  vi.mocked(fileLocks.acquireFileLock).mockImplementationOnce(async (...args) => ({
    ...(await acquire(...args)),
    release: async () => {
      throw failure;
    },
  }));
  await expect(runSemanticCheck({ bin: "fixture" })).rejects.toBe(failure);
  const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { scopeReceipt: string };
  expect(fs.readFileSync(path.join(directory, owner.scopeReceipt), "utf8")).toBe(scope + "\n");
});

it("refuses launch if its scope receipt cannot be written", async () => {
  const failure = new Error("receipt write failed");
  const write = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (String(args[0]).endsWith(".scope-owner")) {
      throw failure;
    }
    return write(...args);
  });
  const launched = vi.fn();
  mocks.run.mockImplementationOnce(async (options: RunManagedCommandOptions) => {
    options.onMemoryScope?.(scope);
    launched();
    return 0;
  });
  await expect(runSemanticCheck({ bin: "fixture" })).rejects.toBe(failure);
  expect(launched).not.toHaveBeenCalled();
  expect(fs.readdirSync(directory)).toEqual([]);
});

it.each(["{}", JSON.stringify({ pid: 2147483647, startedAt: 0 })])(
  "never removes an unverifiable owner: %s",
  async (owner) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(lockPath, owner);
    await expect(runSemanticCheck({ bin: "fixture" })).rejects.toThrow();
    expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
    expect(mocks.run).not.toHaveBeenCalled();
  },
);

it.for(["SIGINT", "SIGTERM", "SIGHUP", "abort"] as const)(
  "owns $0 through asynchronous admission release",
  async (received) => {
    const ready = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    const signal = received === "abort" ? "SIGTERM" : received;
    const previous = process.listeners(signal);
    const acquire = vi.mocked(fileLocks.acquireFileLock).getMockImplementation()!;
    vi.mocked(fileLocks.acquireFileLock).mockImplementationOnce(async (...args) => {
      const lock = await acquire(...args);
      return {
        ...lock,
        release: async () => {
          ready.resolve();
          await release.promise;
          await lock.release();
        },
      };
    });
    const result = runSemanticCheck({ bin: "fixture", signal: controller.signal });
    await ready.promise;
    if (received === "abort") {
      controller.abort();
    } else {
      process.listeners(signal).find((listener) => !previous.includes(listener))!(signal);
    }
    release.resolve();
    if (received === "abort") {
      await expect(result).rejects.toBe(controller.signal.reason);
    } else {
      expect(await result).toBe({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[received]);
    }
    expect(process.listeners(signal)).toEqual(previous);
    expect(fs.readdirSync(directory)).toEqual([]);
  },
);

it.each(["darwin", "win32"])("refuses unsupported %s before admission", async (unsupported) => {
  Object.defineProperty(process, "platform", { value: unsupported });
  expect(await runSemanticCheck({ bin: "fixture" })).toBe(75);
  expect(fileLocks.acquireFileLock).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
