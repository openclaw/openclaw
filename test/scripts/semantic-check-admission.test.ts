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

it.each(["serialized", "canceled", "budgeted", "expired"])(
  "serializes cross-worktree admission with a %s waiter",
  async (outcome) => {
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
    const owner = fs.readFileSync(lockPath, "utf8");
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const controller = new AbortController();
    const waiting = waitForContention();
    const second = runSemanticCheck({
      bin: "second",
      cwd: "/workspace/second",
      env: { HOME: "/second", TMPDIR: "/second/tmp" },
      signal: controller.signal,
      timeoutMs: 60_000,
    }).catch((error: unknown) => error);
    try {
      await waiting;
      expect(mocks.run).toHaveBeenCalledTimes(1);
      if (outcome === "canceled") {
        controller.abort();
        expect(await second).toBe(controller.signal.reason);
        expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
        expect(mocks.run).toHaveBeenCalledTimes(1);
      } else {
        if (outcome !== "serialized") {
          mocks.memory.mockReturnValue({
            capacityBytes: 8 * 1024 ** 3,
            limitBytes: 4 * 1024 ** 3,
            availableBytes: 4 * 1024 ** 3,
            usageKnown: true,
          });
          now += outcome === "expired" ? 61_000 : 40_000;
        }
        release.resolve(0);
        expect(await Promise.all([first, second])).toEqual([0, outcome === "expired" ? 75 : 0]);
        if (outcome === "expired") {
          expect(mocks.run).toHaveBeenCalledTimes(1);
        } else if (outcome === "budgeted") {
          expect(mocks.run).toHaveBeenLastCalledWith(
            expect.objectContaining({ timeoutMs: 20_000, memoryLimitBytes: 2 * 1024 ** 3 }),
          );
        }
      }
    } finally {
      controller.abort();
      release.resolve(0);
      await Promise.all([first, second]);
    }
    expect(fs.readdirSync(directory)).toEqual([]);
  },
);

it.each([
  { capacity: 8, headroom: 6, expected: 3 },
  { capacity: 32, headroom: 24, expected: 8 },
  { capacity: 32, headroom: 2, expected: 1 },
  { capacity: 8, headroom: null, expected: 0 },
  { capacity: 8, headroom: 0.5, expected: 0 },
  { capacity: 32, headroom: 24, available: false, expected: 0 },
  { capacity: 32, headroom: 24, usageKnown: false, expected: 0 },
])("admits only observed headroom within the host budget: %j", async (observation) => {
  const { capacity, headroom, expected } = observation;
  const bytes = headroom === null ? null : headroom * 1024 ** 3;
  mocks.memory.mockReturnValue({
    capacityBytes: capacity * 1024 ** 3,
    limitBytes: bytes,
    availableBytes: observation.available === false ? null : bytes,
    usageKnown: observation.usageKnown ?? true,
  });
  const env = { GOMAXPROCS: "4", GOGC: "100", GOMEMLIMIT: "1GiB" };
  const observe = vi.fn((unit: string) => {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { scopeReceipt: string };
    expect(fs.readFileSync(path.join(directory, owner.scopeReceipt), "utf8")).toBe(unit + "\n");
  });
  expect(await runSemanticCheck({ bin: "fixture", env, onMemoryScope: observe })).toBe(
    expected ? 0 : 75,
  );
  if (expected) {
    expect(observe).toHaveBeenCalledExactlyOnceWith(scope);
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ env, memoryLimitBytes: expected * 1024 ** 3 }),
    );
  } else {
    expect(mocks.run).not.toHaveBeenCalled();
  }
  expect(fs.readdirSync(directory)).toEqual([]);
});

it.each(["live", "indeterminate", "release"])(
  "retains the exact scope receipt after %s cleanup",
  async (processTreeState) => {
    const failure = Object.assign(new Error("cleanup failed"), { processTreeState });
    if (processTreeState === "release") {
      const acquire = vi.mocked(fileLocks.acquireFileLock).getMockImplementation()!;
      vi.mocked(fileLocks.acquireFileLock).mockImplementationOnce(async (...args) => ({
        ...(await acquire(...args)),
        release: async () => {
          throw failure;
        },
      }));
    } else {
      mocks.run.mockImplementationOnce(async (options: RunManagedCommandOptions) => {
        options.onMemoryScope?.(scope);
        throw failure;
      });
    }
    await expect(runSemanticCheck({ bin: "fixture" })).rejects.toBe(failure);
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid: number;
      scopeReceipt: string;
    };
    expect(owner.pid).toBe(process.pid);
    expect(fs.readFileSync(path.join(directory, owner.scopeReceipt), "utf8")).toBe(scope + "\n");
  },
);

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

it("refuses unsupported platforms before admission", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  expect(await runSemanticCheck({ bin: "fixture" })).toBe(75);
  expect(fileLocks.acquireFileLock).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
