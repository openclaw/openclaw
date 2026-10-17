// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import * as fixture from "./run-main.test-support.js";
import process from "node:process";
import { CommanderError } from "commander";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { loggingState } from "../logging/state.js";
import { registerRunMainProxyExitTests } from "./run-main.proxy-exit.test-support.js";
import { registerSignalExitOwner, waitForCliSignalExit } from "./signal-exit-barrier.js";

async function withUncaughtHandler(
  output: "error" | "warn",
  run: (
    handler: NodeJS.UncaughtExceptionListener,
    outputSpy: MockInstance<typeof console.error>,
    exitSpy: MockInstance<typeof process.exit>,
  ) => Promise<void>,
) {
  fixture.buildProgramMock.mockReturnValueOnce(
    fixture.makeProgram("status", vi.fn().mockResolvedValueOnce(undefined)),
  );
  const previousExitCode = process.exitCode;
  const processOnSpy = vi.spyOn(process, "on");
  const outputSpy = vi.spyOn(console, output).mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await fixture.runCli(fixture.cliArgs("status"));
    const handler = processOnSpy.mock.calls.find(([event]) => event === "uncaughtException")?.[1];
    if (typeof handler !== "function") {
      throw new Error("uncaughtException handler was not registered");
    }
    try {
      await run(handler, outputSpy, exitSpy);
    } finally {
      process.off("uncaughtException", handler);
    }
  } finally {
    await waitForCliSignalExit();
    process.exitCode = previousExitCode;
    loggingState.forceConsoleToStderr = false;
    outputSpy.mockRestore();
    exitSpy.mockRestore();
    processOnSpy.mockRestore();
  }
}

describe("runCli exit behavior", () => {
  fixture.installRunMainTestHooks();

  it("cleans resources when runtime preflight rejects before dispatch", async () => {
    const failure = new Error("runtime preflight failed");
    fixture.assertRuntimeMock.mockRejectedValueOnce(failure);
    fixture.hasMemoryRuntimeMock.mockReturnValue(true);
    await expect(fixture.runCli(fixture.cliArgs("status"))).rejects.toBe(failure);
    expect(fixture.closeActiveMemorySearchManagersMock).toHaveBeenCalledOnce();
  });

  it("completes asynchronous teardown before returning to the outer entrypoint", async () => {
    const order: string[] = [];
    fixture.listRegisteredAgentHarnessesMock.mockReturnValueOnce([{ harness: { id: "copilot" } }]);
    fixture.hasProviderTransportDispatcherPoolMock.mockReturnValueOnce(true);
    fixture.getActiveMcpLoopbackRuntimeMock.mockReturnValueOnce({ port: 1234 });
    fixture.hasMemoryRuntimeMock.mockReturnValueOnce(true);
    const cleanupSteps = [
      [fixture.disposeRegisteredAgentHarnessesMock, "harnesses"],
      [fixture.stopManagedProviderLocalServicesMock, "provider-local-services"],
      [fixture.closeProviderTransportDispatcherPoolMock, "provider-transport-dispatchers"],
      [fixture.closeMcpLoopbackServerMock, "mcp-loopback"],
      [fixture.closeActiveMemorySearchManagersMock, "memory"],
    ] as const;
    for (const [mock, name] of cleanupSteps) {
      mock.mockImplementationOnce(async () => {
        await Promise.resolve();
        order.push(name);
      });
    }
    fixture.tryRouteCliMock.mockResolvedValueOnce(true);

    await fixture.runCli(fixture.cliArgs("models", "status", "--probe"));

    expect(order).toEqual([
      "harnesses",
      "provider-local-services",
      "provider-transport-dispatchers",
      "mcp-loopback",
      "memory",
    ]);
    expect(fixture.flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
  });

  registerRunMainProxyExitTests(fixture);

  it("returns after a handled container-target invocation", async () => {
    const previousExitCode = process.exitCode;
    fixture.maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 7 });

    await fixture.runCli(fixture.cliArgs("--container", "demo", "status"));

    expect(fixture.maybeRunCliInContainerMock).toHaveBeenCalledWith(
      fixture.cliArgs("--container", "demo", "status"),
    );
    expect(fixture.enableConsoleCaptureMock).toHaveBeenCalledTimes(1);
    const captureOrder = fixture.enableConsoleCaptureMock.mock.invocationCallOrder[0] ?? 0;
    const containerOrder = fixture.maybeRunCliInContainerMock.mock.invocationCallOrder[0] ?? 0;
    expect(captureOrder).toBeGreaterThan(0);
    expect(containerOrder).toBeGreaterThan(captureOrder);
    expect(fixture.loadDotEnvMock).not.toHaveBeenCalled();
    expect(fixture.tryRouteCliMock).not.toHaveBeenCalled();
    expect(fixture.closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
    process.exitCode = previousExitCode;
  });

  it.each([
    ["status", [], 1, "commander.excessArguments", "too many arguments for 'status'"],
    ["security", ["--help"], 0, "commander.helpDisplayed", "help displayed"],
  ] as const)(
    "records Commander %s exit and flushes only help",
    async (primary, flags, code, kind, message) => {
      const previousExitCode = process.exitCode;
      const argv = fixture.cliArgs(primary, ...flags);
      const program = fixture.makeProgram(
        primary,
        vi.fn().mockRejectedValueOnce(new CommanderError(code, kind, message)),
      );
      fixture.buildProgramMock.mockReturnValueOnce(program);
      await expect(fixture.runCli(argv)).resolves.toBeUndefined();
      expect(fixture.registerSubCliByNameMock.mock.calls).toEqual([[program, primary, argv]]);
      expect(fixture.requestExitAfterOneShotOutputMock).toHaveBeenCalledTimes(code === 0 ? 1 : 0);
      expect(fixture.flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(code);
      process.exitCode = previousExitCode;
    },
  );

  it("restores terminal state before uncaught CLI exits with machine output", async () => {
    await withUncaughtHandler("error", async (handler, outputSpy, exitSpy) => {
      loggingState.forceConsoleToStderr = true;
      handler(new Error("boom"), "uncaughtException");
      expect(await waitForCliSignalExit()).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(outputSpy).toHaveBeenCalledWith(
        "[openclaw] OpenClaw hit an unexpected runtime error.",
      );
      expect(outputSpy).toHaveBeenCalledWith("[openclaw] For help, run `openclaw doctor`.");
      expect(fixture.restoreRuntimeTerminalStateMock).toHaveBeenCalledWith("uncaught exception");
      const owner = vi.fn();
      const releaseOwner = registerSignalExitOwner(owner);
      try {
        handler(new Error("owned failure"), "uncaughtException");
        expect(owner).toHaveBeenCalledExactlyOnceWith(1, "uncaught exception");
      } finally {
        releaseOwner();
      }
    });
  });

  it("does not exit for transient uncaught CLI exceptions", async () => {
    await withUncaughtHandler("warn", async (handler, outputSpy, exitSpy) => {
      const hostUnreachable = Object.assign(new Error("connect EHOSTUNREACH 149.154.167.220:443"), {
        code: "EHOSTUNREACH",
      });
      expect(handler(hostUnreachable, "uncaughtException")).toBeUndefined();
      expect(outputSpy.mock.calls).toEqual([
        ["[openclaw] Non-fatal uncaught exception (continuing):", hostUnreachable.stack],
      ]);
      expect(fixture.restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
