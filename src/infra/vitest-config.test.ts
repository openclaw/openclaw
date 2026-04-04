import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import baseConfig, {
  resolveDefaultVitestPool,
  resolveLocalVitestMaxWorkers,
} from "../../vitest.config.ts";

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
      ),
    ).toBe(3);
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
      ),
    ).toBe(4);
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
      ),
    ).toBe(6);
  });
});

describe("base vitest config", () => {
  it("defaults the base pool to forks", () => {
    expect(resolveDefaultVitestPool()).toBe("forks");
    expect(baseConfig.test?.pool).toBe("forks");
  });

  it("keeps forks even when non-fork pools are requested", () => {
    expect(
      resolveDefaultVitestPool({
        OPENCLAW_VITEST_POOL: "threads",
      }),
    ).toBe("forks");
  });

  it("excludes fixture trees from test collection", () => {
    expect(baseConfig.test?.exclude).toContain("test/fixtures/**");
  });

  it("keeps the base setup file minimal", () => {
    expect(baseConfig.test?.setupFiles).toEqual(["test/setup.ts"]);
  });
});

describe("test scripts", () => {
  it("keeps test:serial pinned to one worker", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.["test:serial"]).toBe(
      "OPENCLAW_VITEST_MAX_WORKERS=1 node scripts/test-projects.mjs",
    );
    expect(pkg.scripts?.["test:single"]).toBeUndefined();
  });
});
