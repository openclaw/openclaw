import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaSelfCheckResult } from "../../extensions/qa-lab/api.js";

const scriptPath = fileURLToPath(new URL("../../scripts/qa-e2e.ts", import.meta.url));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "0");
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("../../extensions/qa-lab/api.js");
});

async function runCli(args: string[], status: "pass" | "fail" = "pass") {
  const result: QaSelfCheckResult = {
    outputPath: "/tmp/qa-self-check.md",
    report: "",
    checks: [{ name: "QA self-check scenario", status }],
    scenarioResult: { name: "QA self-check scenario", status, steps: [] },
  };
  const runQaE2eSelfCheck = vi.fn(async () => result);
  const isQaSelfCheckSuccessful = vi.fn(() => status === "pass");
  const loadRuntime = vi.fn(() => {
    expect(process.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    });
    return { runQaE2eSelfCheck, isQaSelfCheckSuccessful };
  });
  vi.doMock("../../extensions/qa-lab/api.js", loadRuntime);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  try {
    process.argv = [process.execPath, scriptPath, ...args];
    process.exitCode = undefined;
    await import("../../scripts/qa-e2e.js");
    return {
      code: process.exitCode,
      stdout,
      stderr,
      loadRuntime,
      runQaE2eSelfCheck,
      isQaSelfCheckSuccessful,
      result,
    };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  }
}

describe("qa-e2e script", () => {
  it("prints help before enabling private QA or loading QA Lab", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.loadRuntime).not.toHaveBeenCalled();
    expect(result.stdout).toHaveBeenCalledWith(expect.stringContaining("Usage: pnpm qa:e2e"));
    expect(process.env.OPENCLAW_BUILD_PRIVATE_QA).toBe("0");
  });

  it.each([
    [["--wat"], "Unknown qa:e2e option: --wat"],
    [["--output", "--help"], "--output requires a value"],
    [
      ["--output", ".artifacts/first.md", "--output=.artifacts/second.md"],
      "qa:e2e output path was provided more than once",
    ],
    [
      [".artifacts/first.md", "--output", ".artifacts/second.md"],
      "qa:e2e output path was provided more than once",
    ],
  ])("rejects invalid arguments before enabling or loading QA Lab: %j", async (args, message) => {
    const result = await runCli(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toHaveBeenCalledWith(`${message}\n`);
    expect(result.loadRuntime).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_BUILD_PRIVATE_QA).toBe("0");
  });

  it.each([
    [".artifacts/custom.md"],
    ["--output", ".artifacts/custom.md"],
    ["--output=.artifacts/custom.md"],
    ["--", ".artifacts/custom.md"],
  ])("forwards the output destination from %j", async (...args) => {
    const result = await runCli(args);
    expect(result.code).toBe(0);
    expect(result.runQaE2eSelfCheck).toHaveBeenCalledWith({ outputPath: ".artifacts/custom.md" });
  });

  it.each([
    { status: "pass" as const, exitCode: 0 },
    { status: "fail" as const, exitCode: 1 },
  ])("exits with $exitCode when the self-check status is $status", async ({ status, exitCode }) => {
    const result = await runCli([".artifacts/custom.md"], status);
    expect(result.code).toBe(exitCode);
    expect(result.isQaSelfCheckSuccessful).toHaveBeenCalledWith(result.result);
    expect(result.stdout).toHaveBeenCalledWith("QA self-check report: /tmp/qa-self-check.md\n");
  });

  it("lets QA Lab choose the default self-check output path", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(0);
    expect(result.runQaE2eSelfCheck.mock.calls[0]).toEqual([]);
  });
});
