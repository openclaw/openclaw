import os from "node:os";
import { expect, it, vi } from "vitest";
import {
  resolveLocalVitestEnv,
  resolveLocalFullSuiteProfile,
  resolveLocalVitestScheduling,
  type VitestHostInfo,
} from "../../scripts/lib/vitest-local-scheduling.mts";

const GiB = 1024 ** 3;
const hostInfo = (overrides: Partial<VitestHostInfo>) => ({
  cpuCount: 16,
  totalMemoryBytes: 128 * GiB,
  freeMemoryBytes: 32 * GiB,
  loadAverage1m: 0,
  ...overrides,
});
const profile = (shardParallelism: number) => ({ shardParallelism, vitestMaxWorkers: 1 });
const scheduling = (maxWorkers: number, throttledBySystem = false) => ({
  maxWorkers,
  fileParallelism: maxWorkers > 1,
  throttledBySystem,
});

it("sizes separately bundled project configs against one host reading", async () => {
  const store = globalThis as Record<PropertyKey, unknown>;
  const snapshotKey = Symbol.for("openclaw.vitestSchedulingHostInfo");
  const savedSnapshot = Object.getOwnPropertyDescriptor(store, snapshotKey);
  const load = vi.spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
  const constrainedMemory = vi.spyOn(process, "constrainedMemory").mockReturnValue(32 * GiB);
  const availableMemory = vi.spyOn(process, "availableMemory").mockReturnValue(12 * GiB);
  const mocks = [
    load,
    constrainedMemory,
    availableMemory,
    vi.spyOn(os, "availableParallelism").mockReturnValue(16),
    vi.spyOn(os, "totalmem").mockReturnValue(512 * GiB),
    vi.spyOn(os, "freemem").mockReturnValue(256 * GiB),
  ];
  try {
    delete store[snapshotKey];
    vi.resetModules();
    const first = await import("../../scripts/lib/vitest-local-scheduling.mts");
    const before = first.resolveLocalVitestScheduling({});
    expect(before.maxWorkers).toBe(4);
    load.mockReturnValue([64, 64, 64]);
    constrainedMemory.mockReturnValue(2 * GiB);
    availableMemory.mockReturnValue(0);
    vi.resetModules();
    const second = await import("../../scripts/lib/vitest-local-scheduling.mts");
    const after = second.resolveLocalVitestScheduling({});
    // Guard against a vacuous pass: distinct instances, and the stub drives the reading.
    expect(second).not.toBe(first);
    expect(os.loadavg()[0]).toBe(64);
    expect(second.detectVitestHostInfo()).toMatchObject({
      constrainedMemoryBytes: 2 * GiB,
      availableMemoryBytes: 0,
    });
    expect(after).toEqual(before);
  } finally {
    mocks.forEach((mock) => mock.mockRestore());
    if (savedSnapshot) {
      Object.defineProperty(store, snapshotKey, savedSnapshot);
    } else {
      delete store[snapshotKey];
    }
  }
});

it.each([
  [{ cpuCount: 4, totalMemoryBytes: 16 * GiB, loadAverage1m: 3 }, {}, [1, false]],
  [{ freeMemoryBytes: 0, availableMemoryBytes: 6 * GiB }, {}, [2, true]],
  [{ cpuCount: 8, constrainedMemoryBytes: 24 * GiB }, { CI: "true" }, [6, false]],
  [{ cpuCount: 2, loadAverage1m: 1.5, freeMemoryBytes: 0, availableMemoryBytes: 0 }, {}, [1, true]],
  [
    { constrainedMemoryBytes: 16 * GiB, availableMemoryBytes: 0 },
    { OPENCLAW_TEST_WORKERS: "4" },
    [4, false],
  ],
  [{ cpuCount: 8, totalMemoryBytes: 31 * GiB, loadAverage1m: 4 }, { CI: "true" }, [7, false]],
  [{ cpuCount: 32, totalMemoryBytes: 256 * GiB }, {}, [12, false]],
  [{ cpuCount: 14, loadAverage1m: 14, totalMemoryBytes: 48 * GiB }, {}, [1, true]],
  [{ cpuCount: 64, totalMemoryBytes: 512 * GiB, freeMemoryBytes: undefined }, {}, [16, false]],
  [
    { cpuCount: 10, totalMemoryBytes: 24 * GiB, freeMemoryBytes: 3 * GiB },
    { OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1" },
    [4, false],
  ],
] as const)("schedules host %j with %j", (readings, env, [maxWorkers, throttledBySystem]) => {
  const host = hostInfo(readings);
  expect(resolveLocalVitestScheduling(env, host)).toEqual(
    scheduling(maxWorkers, throttledBySystem),
  );
  expect(resolveLocalFullSuiteProfile(env, host)).toEqual(profile(Math.min(maxWorkers, 10)));
});
it.each([
  [{ OPENCLAW_LOCAL_CHECK: "0" }, "1"],
  [{ OPENCLAW_LOCAL_CHECK: "false" }, "1"],
  [{ GITHUB_ACTIONS: "yes", OPENCLAW_LOCAL_CHECK: "0" }, "0"],
] as const)("normalizes local-check policy for %j", (env, expected) => {
  expect(resolveLocalVitestEnv({ ...env, PATH: "/usr/bin" })).toEqual({
    ...env,
    PATH: "/usr/bin",
    OPENCLAW_LOCAL_CHECK: expected,
  });
});

it.each([
  ["OPENCLAW_VITEST_MAX_WORKERS", "8x"],
  ["OPENCLAW_TEST_WORKERS", "1e0"],
] as const)("rejects malformed explicit worker limit %s", (key, value) => {
  expect(() => resolveLocalVitestScheduling({ [key]: value }, hostInfo({}), "threads")).toThrow(
    `${key} must be a positive integer; got: ${value}`,
  );
});
