import os from "node:os";
import { describe, expect, it, vi } from "vitest";
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

it("sizes separately bundled project configs against one host reading", async () => {
  // Separately bundled configs must share worker sizing despite changing host readings.
  const host = os as unknown as Record<string, unknown>;
  const store = globalThis as Record<PropertyKey, unknown>;
  const snapshotKey = Symbol.for("openclaw.vitestSchedulingHostInfo");
  const savedSnapshot = Object.getOwnPropertyDescriptor(store, snapshotKey);
  const saved = {
    availableParallelism: os.availableParallelism,
    totalmem: os.totalmem,
    freemem: os.freemem,
    loadavg: os.loadavg,
  };
  const constrainedMemory = vi.spyOn(process, "constrainedMemory");
  const availableMemory = vi.spyOn(process, "availableMemory");
  try {
    delete store[snapshotKey];
    host.availableParallelism = () => 16;
    host.totalmem = () => 512 * GiB;
    host.freemem = () => 256 * GiB;
    host.loadavg = () => [0, 0, 0];
    constrainedMemory.mockReturnValue(32 * GiB);
    availableMemory.mockReturnValue(12 * GiB);
    vi.resetModules();
    const first = await import("../../scripts/lib/vitest-local-scheduling.mts");
    const before = first.resolveLocalVitestScheduling({});
    expect(before.maxWorkers).toBe(4);
    host.loadavg = () => [64, 64, 64];
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
    Object.assign(host, saved);
    constrainedMemory.mockRestore();
    availableMemory.mockRestore();
    if (savedSnapshot) {
      Object.defineProperty(store, snapshotKey, savedSnapshot);
    } else {
      delete store[snapshotKey];
    }
  }
});

describe("local Vitest scheduling", () => {
  it.each([
    [{ cpuCount: 4, totalMemoryBytes: 16 * GiB, loadAverage1m: 3 }, {}, [1, false]],
    [{ freeMemoryBytes: 0, availableMemoryBytes: 6 * GiB }, {}, [2, true]],
    [{ cpuCount: 8, constrainedMemoryBytes: 24 * GiB }, { CI: "true" }, [6, false]],
    [
      { cpuCount: 2, loadAverage1m: 1.5, freeMemoryBytes: 0, availableMemoryBytes: 0 },
      {},
      [1, true],
    ],
    [
      { constrainedMemoryBytes: 16 * GiB, availableMemoryBytes: 0 },
      { OPENCLAW_TEST_WORKERS: "4" },
      [4, false],
    ],
  ] as const)("schedules host %j with %j", (readings, env, [maxWorkers, throttledBySystem]) => {
    const host = hostInfo(readings);
    expect(resolveLocalVitestScheduling(env, host)).toEqual({
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem,
    });
    expect(resolveLocalFullSuiteProfile(env, host)).toEqual(profile(maxWorkers));
  });

  it.each([
    ["CI half load", { CI: "true" }, 8, 31, 4, 7],
    ["large host", {}, 32, 256, 0, 12],
  ] as const)("%s", (_name, env, cpuCount, totalMemoryGb, loadAverage1m, maxWorkers) => {
    expect(
      resolveLocalVitestScheduling(env, {
        cpuCount,
        totalMemoryBytes: totalMemoryGb * GiB,
        loadAverage1m,
      }),
    ).toEqual({ maxWorkers, fileParallelism: true, throttledBySystem: false });
  });
});

describe("vitest local full-suite profile", () => {
  it("forces local Vitest runs back onto local-check policy", () => {
    for (const value of ["0", "false"]) {
      expect(resolveLocalVitestEnv({ OPENCLAW_LOCAL_CHECK: value, PATH: "/usr/bin" })).toEqual({
        OPENCLAW_LOCAL_CHECK: "1",
        PATH: "/usr/bin",
      });
    }
  });

  it("keeps local-check disablement for GitHub Actions runs", () => {
    expect(
      resolveLocalVitestEnv({ GITHUB_ACTIONS: "yes", OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" }),
    ).toEqual({
      GITHUB_ACTIONS: "yes",
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it.each([
    [
      "throttled host",
      hostInfo({ cpuCount: 14, loadAverage1m: 14, totalMemoryBytes: 48 * GiB }),
      1,
    ],
    ["largest host", { cpuCount: 64, loadAverage1m: 0, totalMemoryBytes: 512 * GiB }, 10],
  ] as const)("caps full-suite fanout: %s", (_name, host, workers) => {
    expect(resolveLocalFullSuiteProfile({}, host)).toEqual(profile(workers));
  });

  it("lets explicit system throttle opt-out ignore memory pressure", () => {
    const env = { OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1" };
    const host = hostInfo({
      cpuCount: 10,
      totalMemoryBytes: 24 * GiB,
      freeMemoryBytes: 3 * GiB,
    });

    expect(resolveLocalVitestScheduling(env, host, "threads")).toEqual({
      maxWorkers: 4,
      fileParallelism: true,
      throttledBySystem: false,
    });
    expect(resolveLocalFullSuiteProfile(env, host)).toEqual(profile(4));
  });

  it("rejects malformed explicit worker limits", () => {
    const host = hostInfo({
      cpuCount: 10,
      totalMemoryBytes: 24 * GiB,
      freeMemoryBytes: 12 * GiB,
    });

    expect(() =>
      resolveLocalVitestScheduling({ OPENCLAW_VITEST_MAX_WORKERS: "8x" }, host, "threads"),
    ).toThrow("OPENCLAW_VITEST_MAX_WORKERS must be a positive integer; got: 8x");
    expect(() =>
      resolveLocalVitestScheduling({ OPENCLAW_TEST_WORKERS: "1e0" }, host, "threads"),
    ).toThrow("OPENCLAW_TEST_WORKERS must be a positive integer; got: 1e0");
  });
});
