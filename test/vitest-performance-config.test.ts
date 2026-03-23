import { describe, expect, it } from "vitest";
import { loadVitestExperimentalConfig } from "../vitest.performance-config.ts";

describe("loadVitestExperimentalConfig", () => {
  it("enables the filesystem module cache by default", () => {
    expect(loadVitestExperimentalConfig({})).toEqual({
      experimental: {
        fsModuleCache: true,
      },
    });
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

  it("allows disabling the filesystem module cache explicitly", () => {
    expect(
      loadVitestExperimentalConfig({
        OPENCLAW_VITEST_FS_MODULE_CACHE: "0",
      }),
    ).toEqual({});
  });

  it("enables import timing output and import breakdown reporting", () => {
    expect(
      loadVitestExperimentalConfig({
        OPENCLAW_VITEST_IMPORT_DURATIONS: "true",
        OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN: "1",
      }),
    ).toEqual({
      experimental: {
        fsModuleCache: true,
        importDurations: { print: true },
        printImportBreakdown: true,
      },
    });
  });
});
