import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  resolveLocalVitestEnv,
  resolveLocalFullSuiteProfile,
  resolveLocalVitestScheduling,
} from "../../scripts/lib/vitest-local-scheduling.mts";

describe("vitest scheduling host snapshot", () => {
  it("sizes separately loaded project configs against one host reading", async () => {
    // Vite bundles each project config on its own, so each project gets its own copy
    // of this module. Vitest refuses a run whose projects share sequence.groupOrder
    // but disagree on maxWorkers, so two module instances that resolve while the
    // load average and process memory readings move must still agree.
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
      host.totalmem = () => 512 * 1024 ** 3;
      host.freemem = () => 256 * 1024 ** 3;
      host.loadavg = () => [0, 0, 0];
      constrainedMemory.mockReturnValue(32 * 1024 ** 3);
      availableMemory.mockReturnValue(12 * 1024 ** 3);
      vi.resetModules();
      const first = await import("../../scripts/lib/vitest-local-scheduling.mts");
      const before = first.resolveLocalVitestScheduling({});
      expect(before.maxWorkers).toBe(4);
      host.loadavg = () => [64, 64, 64];
      constrainedMemory.mockReturnValue(2 * 1024 ** 3);
      availableMemory.mockReturnValue(0);
      vi.resetModules();
      const second = await import("../../scripts/lib/vitest-local-scheduling.mts");
      const after = second.resolveLocalVitestScheduling({});
      // Guard against a vacuous pass: distinct instances, and the stub drives the reading.
      expect(second).not.toBe(first);
      expect(os.loadavg()[0]).toBe(64);
      expect(second.detectVitestHostInfo()).toMatchObject({
        constrainedMemoryBytes: 2 * 1024 ** 3,
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
});

describe("local Vitest scheduling", () => {
  it.each([
    [
      "caps total memory by the process constraint",
      { constrainedMemoryBytes: 16 * 1024 ** 3 },
      {},
      2,
      false,
    ],
    ["limits workers by process headroom", { availableMemoryBytes: 6 * 1024 ** 3 }, {}, 2, true],
    [
      "retains the tighter host headroom",
      { freeMemoryBytes: 3 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3 },
      {},
      1,
      true,
    ],
    [
      "uses process headroom when host free memory is unknown",
      { freeMemoryBytes: 0, availableMemoryBytes: 6 * 1024 ** 3 },
      {},
      2,
      true,
    ],
    [
      "treats a zero process constraint as unknown",
      { constrainedMemoryBytes: 0, availableMemoryBytes: 12 * 1024 ** 3 },
      {},
      8,
      false,
    ],
    ["serializes exhausted process headroom", { availableMemoryBytes: 0 }, {}, 1, true],
    [
      "does not raise exhausted headroom under moderate load",
      { cpuCount: 2, loadAverage1m: 1.5, freeMemoryBytes: 0, availableMemoryBytes: 0 },
      {},
      1,
      true,
    ],
    [
      "does not raise a host memory cap under moderate load",
      { cpuCount: 2, loadAverage1m: 1.5, freeMemoryBytes: 3 * 1024 ** 3 },
      {},
      1,
      true,
    ],
    [
      "retains a valid constraint when headroom is invalid",
      { constrainedMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: NaN },
      {},
      2,
      false,
    ],
    [
      "retains valid headroom when the constraint is invalid",
      { constrainedMemoryBytes: NaN, availableMemoryBytes: 6 * 1024 ** 3 },
      {},
      2,
      true,
    ],
    [
      "ignores negative constraints and infinite headroom",
      { constrainedMemoryBytes: -1, availableMemoryBytes: Infinity },
      {},
      8,
      false,
    ],
    [
      "ignores infinite constraints and negative headroom",
      { constrainedMemoryBytes: Infinity, availableMemoryBytes: -1 },
      {},
      8,
      false,
    ],
    [
      "keeps the host ceiling with an unconstrained uint64 reading",
      { constrainedMemoryBytes: 2 ** 64 - 1 },
      {},
      8,
      false,
    ],
    [
      "lets throttle opt-out ignore headroom but retain the total ceiling",
      { constrainedMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 0 },
      { OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1" },
      2,
      false,
    ],
    [
      "honors an explicit worker override despite process pressure",
      { constrainedMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 0 },
      { OPENCLAW_VITEST_MAX_WORKERS: "3" },
      3,
      false,
    ],
    [
      "honors the legacy worker override despite process pressure",
      { constrainedMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 0 },
      { OPENCLAW_TEST_WORKERS: "4" },
      4,
      false,
    ],
  ] as const)("%s", (_name, readings, env, maxWorkers, throttledBySystem) => {
    const hostInfo = {
      cpuCount: 16,
      totalMemoryBytes: 128 * 1024 ** 3,
      freeMemoryBytes: 32 * 1024 ** 3,
      loadAverage1m: 0,
      ...readings,
    };
    expect(resolveLocalVitestScheduling(env, hostInfo)).toEqual({
      maxWorkers,
      fileParallelism: maxWorkers > 1,
      throttledBySystem,
    });
    expect(resolveLocalFullSuiteProfile(env, hostInfo)).toEqual({
      shardParallelism: maxWorkers,
      vitestMaxWorkers: 1,
    });
  });

  it.each([
    ["uses a moderate cap on larger hosts", { RUNNER_OS: "macOS" }, 10, 64, 0, 6, false],
    [
      "honors OPENCLAW_VITEST_MAX_WORKERS",
      { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      10,
      128,
      0,
      2,
      false,
    ],
    [
      "honors the legacy OPENCLAW_TEST_WORKERS override",
      { OPENCLAW_TEST_WORKERS: "3" },
      16,
      128,
      0,
      3,
      false,
    ],
    ["keeps memory-constrained hosts conservative", {}, 16, 16, 0, 2, false],
    ["lets roomy hosts use more parallelism", {}, 16, 128, 0, 8, false],
    ["backs off when host load is saturated", {}, 16, 128, 16, 2, true],
    ["caps very large hosts at twelve workers", {}, 32, 256, 0, 12, false],
    ["keeps big hosts parallel under moderate contention", {}, 16, 128, 12, 5, true],
    [
      "allows explicitly disabling system throttling",
      { OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1" },
      16,
      128,
      0.5,
      8,
      false,
    ],
  ] as const)(
    "%s",
    (_name, env, cpuCount, totalMemoryGb, loadAverage1m, maxWorkers, throttledBySystem) => {
      expect(
        resolveLocalVitestScheduling(env, {
          cpuCount,
          totalMemoryBytes: totalMemoryGb * 1024 ** 3,
          loadAverage1m,
        }),
      ).toEqual({ maxWorkers, fileParallelism: true, throttledBySystem });
    },
  );
});

describe("vitest local full-suite profile", () => {
  it("forces local Vitest runs back onto local-check policy", () => {
    expect(resolveLocalVitestEnv({ OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
    expect(resolveLocalVitestEnv({ OPENCLAW_LOCAL_CHECK: "false", PATH: "/usr/bin" })).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it.each([
    ["CI", "1"],
    ["CI", "true"],
    ["GITHUB_ACTIONS", "yes"],
    ["GITHUB_ACTIONS", "on"],
  ] as const)("keeps local-check disablement for %s=%s Vitest runs", (name, value) => {
    expect(
      resolveLocalVitestEnv({
        [name]: value,
        OPENCLAW_LOCAL_CHECK: "0",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      [name]: value,
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("spends the host worker budget once across full-suite shards", () => {
    const env = {};
    const hostInfo = {
      cpuCount: 14,
      loadAverage1m: 0,
      totalMemoryBytes: 48 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling(env, hostInfo, "threads")).toEqual({
      maxWorkers: 6,
      fileParallelism: true,
      throttledBySystem: false,
    });
    expect(resolveLocalFullSuiteProfile(env, hostInfo)).toEqual({
      shardParallelism: 6,
      vitestMaxWorkers: 1,
    });
  });

  it("reduces full-suite shard concurrency when the host is already throttled", () => {
    const hostInfo = {
      cpuCount: 14,
      loadAverage1m: 14,
      totalMemoryBytes: 48 * 1024 ** 3,
      freeMemoryBytes: 32 * 1024 ** 3,
    };

    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 1,
      vitestMaxWorkers: 1,
    });
  });

  it("caps full-suite process fanout on the largest hosts", () => {
    const hostInfo = {
      cpuCount: 64,
      loadAverage1m: 0,
      totalMemoryBytes: 512 * 1024 ** 3,
    };

    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 10,
      vitestMaxWorkers: 1,
    });
  });

  it("serializes local full-suite shards under critical memory pressure", () => {
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 3 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling({}, hostInfo, "threads")).toEqual({
      maxWorkers: 1,
      fileParallelism: false,
      throttledBySystem: true,
    });
    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 1,
      vitestMaxWorkers: 1,
    });
  });

  it("limits local full-suite shards when memory is tight", () => {
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 6 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling({}, hostInfo, "threads")).toEqual({
      maxWorkers: 2,
      fileParallelism: true,
      throttledBySystem: true,
    });
    expect(resolveLocalFullSuiteProfile({}, hostInfo)).toEqual({
      shardParallelism: 2,
      vitestMaxWorkers: 1,
    });
  });

  it("lets explicit system throttle opt-out ignore memory pressure", () => {
    const env = { OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1" };
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 3 * 1024 ** 3,
    };

    expect(resolveLocalVitestScheduling(env, hostInfo, "threads")).toEqual({
      maxWorkers: 4,
      fileParallelism: true,
      throttledBySystem: false,
    });
    expect(resolveLocalFullSuiteProfile(env, hostInfo)).toEqual({
      shardParallelism: 4,
      vitestMaxWorkers: 1,
    });
  });

  it("rejects malformed explicit worker limits", () => {
    const hostInfo = {
      cpuCount: 10,
      loadAverage1m: 0,
      totalMemoryBytes: 24 * 1024 ** 3,
      freeMemoryBytes: 12 * 1024 ** 3,
    };

    expect(() =>
      resolveLocalVitestScheduling({ OPENCLAW_VITEST_MAX_WORKERS: "8x" }, hostInfo, "threads"),
    ).toThrow("OPENCLAW_VITEST_MAX_WORKERS must be a positive integer; got: 8x");
    expect(() =>
      resolveLocalVitestScheduling({ OPENCLAW_TEST_WORKERS: "1e0" }, hostInfo, "threads"),
    ).toThrow("OPENCLAW_TEST_WORKERS must be a positive integer; got: 1e0");
  });
});
