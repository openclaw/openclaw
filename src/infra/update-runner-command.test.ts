import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import * as processExec from "../process/exec.js";
import type { SpawnResult } from "../process/exec.js";
import * as updateGlobal from "./update-global.js";
import { buildUpdateCommandRunner, runStep } from "./update-runner-command.js";

describe("default updater Git transport", () => {
  const failure: SpawnResult = {
    code: 128,
    stdout: "",
    stderr:
      "error: RPC failed; curl 56 GnuTLS recv error (-9): Error decoding the received TLS packet.\nfatal: early EOF",
    termination: "exit",
    killed: false,
    signal: null,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    vi.spyOn(updateGlobal, "createGlobalInstallEnv").mockResolvedValue({
      OPENCLAW_UPDATE_TEST_ENV: "1",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "unbounded slow transfer",
      timeoutMs: undefined,
      elapsedMs: 538_000,
      retryMs: undefined,
    },
    { label: "explicit remaining budget", timeoutMs: 10_000, elapsedMs: 3_000, retryMs: 6_000 },
  ])("recovers a transient fetch with $label before publishing completion", async (testCase) => {
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() + elapsedMs);
    const execute = vi
      .spyOn(processExec, "runCommandWithTimeout")
      .mockImplementationOnce(async () => {
        elapsedMs = testCase.elapsedMs;
        return failure;
      })
      .mockResolvedValueOnce({ ...failure, code: 0, stderr: "", stdout: "fetched target" });
    const { runCommand } = await buildUpdateCommandRunner();
    const onStepComplete = vi.fn();
    const argv = [
      "git",
      "-C",
      "/checkout",
      "--git-dir=/inspection",
      "fetch",
      "origin",
      "--no-tags",
    ];
    const pending = runStep({
      name: "git-target-inspection-fetch",
      argv,
      cwd: "/checkout",
      timeoutMs: testCase.timeoutMs,
      env: { GIT_CONFIG_NOSYSTEM: "1" },
      runCommand,
      stepIndex: 0,
      totalSteps: 1,
      progress: { onStepComplete },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ exitCode: 0, stdoutTail: "fetched target" });
    expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ exitCode: 0 }),
    );
    expect(onStepComplete.mock.calls[0]?.[0].failureFacts).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [index, timeoutMs] of [testCase.timeoutMs, testCase.retryMs].entries()) {
      expect(execute).toHaveBeenNthCalledWith(index + 1, argv, {
        cwd: "/checkout",
        timeoutMs,
        env: { OPENCLAW_UPDATE_TEST_ENV: "1", GIT_CONFIG_NOSYSTEM: "1" },
        killProcessTree: true,
      });
    }
  });

  it.each([
    { label: "package installation", argv: ["pnpm", "install"], result: failure },
    {
      label: "authentication rejection",
      argv: ["git", "fetch", "origin"],
      result: { ...failure, stderr: "fatal: Authentication failed" },
    },
    {
      label: "timed-out fetch",
      argv: ["git", "fetch", "origin"],
      result: { ...failure, killed: true, termination: "timeout" as const },
    },
  ])("retains the failure without replaying $label", async ({ argv, result }) => {
    const execute = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue(result);
    const { runCommand } = await buildUpdateCommandRunner();
    const pending = runCommand(argv, { cwd: "/checkout" });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("settles inherited command cancellation during backoff without another attempt", async () => {
    const execute = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue(failure);
    const { runCommand } = await buildUpdateCommandRunner();
    const controller = new AbortController();
    let outcome: Awaited<ReturnType<typeof runCommand>> | undefined;
    const pending = withCommandProcessScope(
      () => runCommand(["git", "fetch", "origin"], { cwd: "/checkout" }),
      controller.signal,
    ).then((result) => {
      outcome = result;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toMatchObject({ code: null, termination: "signal" });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await vi.runAllTimersAsync();
      await pending;
    }
  });
});

describe("update command failure diagnostics", () => {
  it.each(["stderr", "stdout"] as const)(
    "keeps the sanitized child cause below a package-manager banner in %s",
    async (stream) => {
      const diagnostic = `\u001b[31mError: Candidate build refused; token=fixture-private-token ${"detail ".repeat(50)}\u001b[0m`;
      const result = await runStep({
        name: "preflight-build",
        argv: ["pnpm", "build"],
        cwd: "/fixture",
        timeoutMs: 1000,
        stepIndex: 0,
        totalSteps: 1,
        runCommand: async () => ({
          code: 17,
          stdout: stream === "stdout" ? diagnostic : "",
          stderr:
            stream === "stderr"
              ? `$ node scripts/build-all.mts\n${diagnostic}\n`
              : "$ node scripts/build-all.mts\n",
        }),
      });
      expect(result.exitCode).toBe(17);
      expect(result.failureFacts?.[0]?.message).toContain("Candidate build refused");
      expect(result.failureFacts?.[0]?.message).not.toContain("fixture-private-token");
      expect(result.failureFacts?.[0]?.message).not.toContain("\u001b");
      expect(result.failureFacts?.[0]?.message?.length).toBeLessThanOrEqual(200);
    },
  );
  it.each([
    {
      name: "non-banner",
      stderr: "Compiler rejected candidate\nError: secondary context",
      stdout: "Error: later output",
      expected: "Compiler rejected candidate",
    },
    {
      name: "banner without an error header",
      stderr: "$ node scripts/build-all.mts\ncompiler status: failed",
      stdout: "",
      expected: "$ node scripts/build-all.mts",
    },
  ])("preserves the $name diagnostic fallback", async ({ stderr, stdout, expected }) => {
    const result = await runStep({
      name: "preflight-build",
      argv: ["pnpm", "build"],
      cwd: "/fixture",
      timeoutMs: 1000,
      stepIndex: 0,
      totalSteps: 1,
      runCommand: async () => ({ code: 17, stderr, stdout }),
    });
    expect(result.failureFacts?.[0]?.message).toBe(expected);
  });
});
