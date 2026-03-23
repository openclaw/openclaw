import { describe, expect, it } from "vitest";
import { loadVitestExperimentalConfig } from "../vitest.performance-config.ts";

describe("loadVitestExperimentalConfig", () => {
  it("returns an empty object when no perf flags are enabled", () => {
    expect(loadVitestExperimentalConfig({})).toEqual({});
  });

  it("enables the filesystem module cache explicitly", () => {
    expect(
      loadVitestExperimentalConfig({
        OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
      }),
    ).toEqual({
      experimental: {
        fsModuleCache: true,
      },
    });
  });

  it("enables import timing output and import breakdown reporting", () => {
    expect(
      loadVitestExperimentalConfig({
        OPENCLAW_VITEST_IMPORT_DURATIONS: "true",
        OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN: "1",
      }),
    ).toEqual({
      experimental: {
        importDurations: { print: true },
        printImportBreakdown: true,
      },
    });
  });
});
