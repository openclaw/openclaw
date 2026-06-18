// Qa E2E tests cover qa e2e script behavior.
import { describe, expect, it, vi } from "vitest";
import type { QaSelfCheckResult } from "../../extensions/qa-lab/api.js";
import { enablePrivateQaScriptEnv, main, resolveQaE2eOutputPath } from "../../scripts/qa-e2e.js";

function makeSelfCheckResult(status: "pass" | "fail"): QaSelfCheckResult {
  return {
    outputPath: "/tmp/qa-self-check.md",
    report: "",
    checks: [{ name: "QA self-check scenario", status }],
    scenarioResult: {
      name: "QA self-check scenario",
      status,
      steps: [],
    },
  };
}

describe("qa-e2e script", () => {
  it("enables private QA plugin SDK subpaths before loading QA Lab", () => {
    const env: NodeJS.ProcessEnv = {};

    enablePrivateQaScriptEnv(env);

    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(env.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS).toBe("0");
  });

  it("overrides inherited environment that would break the private QA self-check", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "0",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };

    enablePrivateQaScriptEnv(env);

    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(env.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS).toBe("0");
  });

  it("resolves the default self-check report path", () => {
    expect(resolveQaE2eOutputPath([])).toBe(".artifacts/qa-e2e/self-check.md");
    expect(resolveQaE2eOutputPath([".artifacts/custom.md"])).toBe(".artifacts/custom.md");
  });

  it.each([
    { status: "pass" as const, exitCode: 0 },
    { status: "fail" as const, exitCode: 1 },
  ])("exits with $exitCode when the self-check status is $status", async ({ status, exitCode }) => {
    const result = makeSelfCheckResult(status);
    const runQaE2eSelfCheck = vi.fn(async () => result);
    const isQaSelfCheckSuccessful = vi.fn(() => status === "pass");
    const writeStdout = vi.fn();
    const env: NodeJS.ProcessEnv = {};

    await expect(
      main([".artifacts/custom.md"], {
        env,
        loadRuntime: async () => ({
          isQaSelfCheckSuccessful,
          runQaE2eSelfCheck,
        }),
        writeStdout,
      }),
    ).resolves.toBe(exitCode);

    expect(runQaE2eSelfCheck).toHaveBeenCalledWith({ outputPath: ".artifacts/custom.md" });
    expect(isQaSelfCheckSuccessful).toHaveBeenCalledWith(result);
    expect(writeStdout).toHaveBeenCalledWith("QA self-check report: /tmp/qa-self-check.md\n");
    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
  });
});
