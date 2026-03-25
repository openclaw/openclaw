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

  it("disables the filesystem module cache by default on Windows", () => {
    const originalRunnerOs = process.env.RUNNER_OS;
    process.env.RUNNER_OS = "Windows";
    try {
      expect(loadVitestExperimentalConfig({ RUNNER_OS: "Windows" })).toEqual({});
    } finally {
      if (originalRunnerOs === undefined) {
        delete process.env.RUNNER_OS;
      } else {
        process.env.RUNNER_OS = originalRunnerOs;
      }
    }
  });

  it("still allows enabling the filesystem module cache explicitly on Windows", () => {
    const originalRunnerOs = process.env.RUNNER_OS;
    process.env.RUNNER_OS = "Windows";
    try {
      expect(
        loadVitestExperimentalConfig({
          RUNNER_OS: "Windows",
          OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
        }),
      ).toEqual({
        experimental: {
          fsModuleCache: true,
        },
      });
    } finally {
      if (originalRunnerOs === undefined) {
        delete process.env.RUNNER_OS;
      } else {
        process.env.RUNNER_OS = originalRunnerOs;
      }
    }
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
