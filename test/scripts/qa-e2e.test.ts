// Qa E2E tests cover qa e2e script behavior.
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { QaSelfCheckResult } from "../../extensions/qa-lab/api.js";
import { enablePrivateQaScriptEnv, main, parseQaE2eArgs } from "../../scripts/qa-e2e.js";

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
    expect(parseQaE2eArgs([]).outputPath).toBeUndefined();
    expect(parseQaE2eArgs([".artifacts/custom.md"]).outputPath).toBe(".artifacts/custom.md");
    expect(parseQaE2eArgs(["--output", ".artifacts/custom.md"]).outputPath).toBe(
      ".artifacts/custom.md",
    );
    expect(parseQaE2eArgs(["--", ".artifacts/custom.md"]).outputPath).toBe(".artifacts/custom.md");
  });

  it("prints help before enabling private QA or loading QA Lab", async () => {
    const env: NodeJS.ProcessEnv = {};
    const loadRuntime = vi.fn(async () => {
      throw new Error("runtime loaded");
    });
    const writeStdout = vi.fn();

    await expect(main(["--help"], { env, loadRuntime, writeStdout })).resolves.toBe(0);

    expect(loadRuntime).not.toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("Usage: pnpm qa:e2e"));
    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBeUndefined();
  });

  it("rejects unknown options before enabling private QA or loading QA Lab", async () => {
    const env: NodeJS.ProcessEnv = {};
    const loadRuntime = vi.fn(async () => {
      throw new Error("runtime loaded");
    });

    await expect(main(["--wat"], { env, loadRuntime })).rejects.toThrow(
      "Unknown qa:e2e option: --wat",
    );

    expect(loadRuntime).not.toHaveBeenCalled();
    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBeUndefined();
  });

  it("parses explicit output flags and package-manager separators", () => {
    expect(parseQaE2eArgs(["--output=.artifacts/custom.md"])).toEqual({
      help: false,
      outputPath: ".artifacts/custom.md",
    });
    expect(parseQaE2eArgs(["--", ".artifacts/from-separator.md"])).toEqual({
      help: false,
      outputPath: ".artifacts/from-separator.md",
    });
    expect(() => parseQaE2eArgs(["--output", "--help"])).toThrow("--output requires a value");
  });

  it("rejects duplicate output destinations before loading QA Lab", async () => {
    const env: NodeJS.ProcessEnv = {};
    const loadRuntime = vi.fn(async () => {
      throw new Error("runtime loaded");
    });

    expect(() =>
      parseQaE2eArgs(["--output", ".artifacts/first.md", "--output=.artifacts/second.md"]),
    ).toThrow("qa:e2e output path was provided more than once");
    await expect(
      main([".artifacts/first.md", "--output", ".artifacts/second.md"], { env, loadRuntime }),
    ).rejects.toThrow("qa:e2e output path was provided more than once");

    expect(loadRuntime).not.toHaveBeenCalled();
    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBeUndefined();
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

  it("lets QA Lab choose the default self-check output path", async () => {
    const result = makeSelfCheckResult("pass");
    const runQaE2eSelfCheck = vi.fn(async () => result);
    const env: NodeJS.ProcessEnv = {};

    await expect(
      main([], {
        env,
        loadRuntime: async () => ({
          isQaSelfCheckSuccessful: () => true,
          runQaE2eSelfCheck,
        }),
      }),
    ).resolves.toBe(0);

    expect(runQaE2eSelfCheck.mock.calls[0]).toEqual([]);
  });

  it("prints both self-check and shutdown failures with redaction and a nonzero exit", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const checkError = new Error(`self-check failed: Authorization: Bearer ${token}`);
    const shutdownError = new Error("Gateway shutdown failed");
    const runQaE2eSelfCheck = vi.fn().mockRejectedValue(
      new AggregateError([checkError, shutdownError], "QA self-check and shutdown failed", {
        cause: checkError,
      }),
    );
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const writeStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const key of [
      "OPENCLAW_BUILD_PRIVATE_QA",
      "OPENCLAW_ENABLE_PRIVATE_QA_CLI",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    ]) {
      vi.stubEnv(key, process.env[key]);
    }
    vi.resetModules();
    vi.doMock("../../extensions/qa-lab/api.js", () => ({
      isQaSelfCheckSuccessful: vi.fn(),
      runQaE2eSelfCheck,
    }));
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("../../scripts/qa-e2e.ts", import.meta.url)),
    ];
    process.exitCode = 0;
    try {
      await import("../../scripts/qa-e2e.js");

      expect(process.exitCode).toBe(1);
      expect(runQaE2eSelfCheck).toHaveBeenCalledOnce();
      expect(writeStderr).toHaveBeenCalledOnce();
      const diagnostic = String(writeStderr.mock.calls[0]?.[0]);
      expect(diagnostic).toContain("QA self-check and shutdown failed");
      expect(diagnostic).toContain("self-check failed: Authorization: Bearer");
      expect(diagnostic).toContain("Gateway shutdown failed");
      expect(diagnostic).not.toContain(token);
    } finally {
      process.argv = originalArgv;
      // Bun cannot clear a nonzero exitCode by assigning undefined.
      process.exitCode = originalExitCode ?? 0;
      vi.doUnmock("../../extensions/qa-lab/api.js");
      vi.resetModules();
      vi.unstubAllEnvs();
      writeStderr.mockRestore();
    }
  });
});
