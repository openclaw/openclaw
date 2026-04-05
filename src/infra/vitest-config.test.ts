import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import baseConfig, {
  resolveDefaultVitestPool,
  resolveLocalVitestMaxWorkers,
  resolveLocalVitestScheduling,
} from "../../vitest.config.ts";
import { parseVitestProcessStats } from "../../vitest.system-load.ts";

const idleVitestStats = {
  otherVitestRootCount: 0,
  otherVitestWorkerCount: 0,
  otherVitestCpuPercent: 0,
} as const;

describe("resolveLocalVitestMaxWorkers", () => {
  it("uses a moderate local worker cap on larger hosts", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          RUNNER_OS: "macOS",
        },
        {
          cpuCount: 10,
          loadAverage1m: 0,
          totalMemoryBytes: 64 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(6);
  });

  it("lets OPENCLAW_VITEST_MAX_WORKERS override the inferred cap", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          OPENCLAW_VITEST_MAX_WORKERS: "2",
        },
        {
          cpuCount: 10,
          loadAverage1m: 0,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(2);
  });

  it("respects the legacy OPENCLAW_TEST_WORKERS override too", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          OPENCLAW_TEST_WORKERS: "3",
        },
        {
          cpuCount: 16,
          loadAverage1m: 0,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(3);
  });

  it("keeps memory-constrained hosts conservative", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {},
        {
          cpuCount: 16,
          loadAverage1m: 0,
          totalMemoryBytes: 16 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(2);
  });

  it("lets roomy hosts use more local parallelism", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {},
        {
          cpuCount: 16,
          loadAverage1m: 0,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(8);
  });

  it("backs off further when the host is already busy", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {},
        {
          cpuCount: 16,
          loadAverage1m: 16,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(2);
  });

  it("caps very large hosts at six local workers", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {},
        {
          cpuCount: 32,
          loadAverage1m: 0,
          totalMemoryBytes: 256 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toBe(12);
  });
});

describe("resolveLocalVitestScheduling", () => {
  it("scales back to half capacity when other Vitest work is already consuming most cores", () => {
    expect(
      resolveLocalVitestScheduling(
        {},
        {
          cpuCount: 16,
          loadAverage1m: 0.5,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        {
          otherVitestRootCount: 2,
          otherVitestWorkerCount: 12,
          otherVitestCpuPercent: 1200,
        },
      ),
    ).toEqual({
      maxWorkers: 4,
      fileParallelism: true,
      throttledBySystem: true,
    });
  });

  it("keeps big hosts parallel under moderate contention", () => {
    expect(
      resolveLocalVitestScheduling(
        {},
        {
          cpuCount: 16,
          loadAverage1m: 0.5,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        {
          otherVitestRootCount: 1,
          otherVitestWorkerCount: 7,
          otherVitestCpuPercent: 700,
        },
      ),
    ).toEqual({
      maxWorkers: 6,
      fileParallelism: true,
      throttledBySystem: true,
    });
  });

  it("allows disabling the system throttle probe explicitly", () => {
    expect(
      resolveLocalVitestScheduling(
        {
          OPENCLAW_VITEST_DISABLE_SYSTEM_THROTTLE: "1",
        },
        {
          cpuCount: 16,
          loadAverage1m: 0.5,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
        "threads",
        idleVitestStats,
      ),
    ).toEqual({
      maxWorkers: 8,
      fileParallelism: true,
      throttledBySystem: false,
    });
  });
});

describe("parseVitestProcessStats", () => {
  it("counts other Vitest roots and workers while excluding the current pid", () => {
    expect(
      parseVitestProcessStats(
        [
          "101 0.0 node /Users/me/project/node_modules/.bin/vitest run --config vitest.config.ts",
          "102 41.3 /opt/homebrew/bin/node /Users/me/project/node_modules/vitest/dist/workers/forks.js",
          "103 37.4 /opt/homebrew/bin/node /Users/me/project/node_modules/vitest/dist/workers/forks.js",
          "200 12.0 node /Users/me/project/node_modules/.bin/vitest run --config vitest.unit.config.ts",
          "201 25.5 node unrelated-script.mjs",
        ].join("\n"),
        200,
      ),
    ).toEqual({
      otherVitestRootCount: 1,
      otherVitestWorkerCount: 2,
      otherVitestCpuPercent: 78.7,
    });
  });
});

describe("base vitest config", () => {
  it("defaults the base pool to threads", () => {
    expect(resolveDefaultVitestPool()).toBe("threads");
    expect(baseConfig.test?.pool).toBe("threads");
  });

  it("excludes fixture trees from test collection", () => {
    expect(baseConfig.test?.exclude).toContain("test/fixtures/**");
  });

  it("keeps the base setup file minimal", () => {
    expect(baseConfig.test?.setupFiles).toEqual(["test/setup.ts"]);
  });

  it("keeps the base runner non-isolated by default", () => {
    expect(baseConfig.test?.isolate).toBe(false);
    expect(baseConfig.test?.runner).toBe("./test/non-isolated-runner.ts");
  });
});

describe("test scripts", () => {
  it("keeps test scripts on the native thread-first configs", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.["test:serial"]).toBe(
      "OPENCLAW_VITEST_MAX_WORKERS=1 vitest run --config vitest.config.ts",
    );
    expect(pkg.scripts?.["test:fast"]).toBe(
      "node scripts/run-vitest.mjs run --config vitest.unit.config.ts",
    );
    expect(pkg.scripts?.["test:gateway"]).toBe("vitest run --config vitest.gateway.config.ts");
    expect(pkg.scripts?.["test:single"]).toBeUndefined();
  });
});
