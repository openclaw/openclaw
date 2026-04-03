import { describe, expect, it } from "vitest";
import baseConfig, { resolveLocalVitestMaxWorkers } from "../vitest.config.ts";

describe("resolveLocalVitestMaxWorkers", () => {
  it("defaults local runs to a single worker even on larger hosts", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          RUNNER_OS: "macOS",
        },
        {
          cpuCount: 10,
          totalMemoryBytes: 64 * 1024 ** 3,
        },
      ),
    ).toBe(1);
  });

  it("lets OPENCLAW_VITEST_MAX_WORKERS override the inferred cap", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {
          OPENCLAW_VITEST_MAX_WORKERS: "2",
        },
        {
          cpuCount: 10,
          totalMemoryBytes: 128 * 1024 ** 3,
          platform: "darwin",
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
          totalMemoryBytes: 128 * 1024 ** 3,
        },
      ),
    ).toBe(3);
  });

  it("keeps memory-constrained hosts on the same single-worker default", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {},
        {
          cpuCount: 16,
          totalMemoryBytes: 16 * 1024 ** 3,
        },
      ),
    ).toBe(1);
  });

  it("keeps roomy hosts on the same single-worker default", () => {
    expect(
      resolveLocalVitestMaxWorkers(
        {},
        {
          cpuCount: 16,
          totalMemoryBytes: 128 * 1024 ** 3,
        },
      ),
    ).toBe(1);
  });
});

describe("base vitest config", () => {
  it("excludes fixture trees from test collection", () => {
    expect(baseConfig.test?.exclude).toContain("test/fixtures/**");
  });

  it("keeps the base setup file minimal", () => {
    expect(baseConfig.test?.setupFiles).toEqual(["test/setup.ts"]);
  });
});
