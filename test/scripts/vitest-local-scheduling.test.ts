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
      "does not raise a four-core inferred budget under moderate load",
      { cpuCount: 4, totalMemoryBytes: 16 * 1024 ** 3, loadAverage1m: 3 },
      {},
      1,
      false,
    ],
    [
      "uses process headroom when host free memory is unknown",
      { freeMemoryBytes: 0, availableMemoryBytes: 6 * 1024 ** 3 },
      {},
      2,
      true,
    ],
    [
      "uses constrained capacity for the CI tier",
      { cpuCount: 8, constrainedMemoryBytes: 24 * 1024 ** 3 },
      { CI: "true" },
      6,
      false,
    ],
    [
      "does not raise exhausted headroom under moderate load",
      { cpuCount: 2, loadAverage1m: 1.5, freeMemoryBytes: 0, availableMemoryBytes: 0 },
      {},
      1,
      true,
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
    ["backs off the measured CI tier at half load", { CI: "true" }, 8, 31, 4, 7, false],
    ["caps very large hosts at twelve workers", {}, 32, 256, 0, 12, false],
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

  it.each([["GITHUB_ACTIONS", "yes"]] as const)(
    "keeps local-check disablement for %s=%s Vitest runs",
    (name, value) => {
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
    },
  );

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
