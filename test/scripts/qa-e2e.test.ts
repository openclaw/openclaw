import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const scriptPath = fileURLToPath(new URL("../../scripts/qa-e2e.ts", import.meta.url));
const outputPath = ".artifacts/custom.md";
const duplicateOutput = "qa:e2e output path was provided more than once";
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  vi.resetModules();
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "0");
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("../../extensions/qa-lab/api.js");
});

async function runCli(args: string[], status: "pass" | "fail" = "pass") {
  const result = { outputPath: "/tmp/qa-self-check.md" };
  const runtime = {
    runQaE2eSelfCheck: vi.fn(async () => result),
    isQaSelfCheckSuccessful: vi.fn(() => status === "pass"),
  };
  const loadRuntime = vi.fn(() => {
    expect(process.env).toMatchObject({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    });
    return runtime;
  });
  // mock-isolation: Exercise CLI parsing without loading or running the private QA runtime.
  vi.doMock("../../extensions/qa-lab/api.js", loadRuntime);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.argv = [process.execPath, scriptPath, ...args];
  process.exitCode = undefined;
  await import("../../scripts/qa-e2e.js");
  return { code: process.exitCode, stdout, stderr, loadRuntime, runtime, result };
}

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
  [["--output", "first.md", "--output=second.md"], duplicateOutput],
  [["first.md", "--output", "second.md"], duplicateOutput],
])("rejects invalid arguments before enabling or loading QA Lab: %j", async (args, message) => {
  const result = await runCli(args);
  expect(result.code).toBe(1);
  expect(result.stderr).toHaveBeenCalledWith(`${message}\n`);
  expect(result.loadRuntime).not.toHaveBeenCalled();
  expect(process.env.OPENCLAW_BUILD_PRIVATE_QA).toBe("0");
});

it.each([
  [[outputPath], "pass"],
  [["--output", outputPath], "pass"],
  [[`--output=${outputPath}`], "pass"],
  [["--", outputPath], "pass"],
  [[outputPath], "fail"],
  [[], "pass"],
] as const)("runs self-check with %j and preserves %s verdict", async (args, status) => {
  const result = await runCli([...args], status);
  expect(result.code).toBe(status === "pass" ? 0 : 1);
  expect(result.runtime.runQaE2eSelfCheck.mock.calls).toEqual([
    args.length ? [{ outputPath }] : [],
  ]);
  expect(result.runtime.isQaSelfCheckSuccessful).toHaveBeenCalledWith(result.result);
  expect(result.stdout).toHaveBeenCalledWith("QA self-check report: /tmp/qa-self-check.md\n");
});
