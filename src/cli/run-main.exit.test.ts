// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installRunMainTestHooks,
  cliArgs,
  runCli,
  tryRouteCliMock,
  loadDotEnvMock,
  closeActiveMemorySearchManagersMock,
  hasMemoryRuntimeMock,
  listRegisteredAgentHarnessesMock,
  disposeRegisteredAgentHarnessesMock,
  hasProviderTransportDispatcherPoolMock,
  stopManagedProviderLocalServicesMock,
  closeProviderTransportDispatcherPoolMock,
  getActiveMcpLoopbackRuntimeMock,
  closeMcpLoopbackServerMock,
  buildProgramMock,
  assertRuntimeMock,
  registerSubCliByNameMock,
  restoreRuntimeTerminalStateMock,
  enableConsoleCaptureMock,
  startProxyMock,
  stopProxyMock,
  flushExitAfterOneShotOutputMock,
  requestExitAfterOneShotOutputMock,
  maybeRunCliInContainerMock,
} from "./run-main.test-support.js";
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
  buildProgramMock.mockReturnValueOnce({
    commands: [{ name: () => "status" }],
    parseAsync: vi.fn().mockResolvedValueOnce(undefined),
  });
  const previousExitCode = process.exitCode;
  const processOnSpy = vi.spyOn(process, "on");
  const outputSpy = vi.spyOn(console, output).mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  try {
    await runCli(cliArgs("status"));
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
  installRunMainTestHooks();

  it("cleans resources when runtime preflight rejects before dispatch", async () => {
    const failure = new Error("runtime preflight failed");
    assertRuntimeMock.mockRejectedValueOnce(failure);
    hasMemoryRuntimeMock.mockReturnValue(true);
    await expect(runCli(["node", "openclaw", "status"])).rejects.toBe(failure);
    expect(closeActiveMemorySearchManagersMock).toHaveBeenCalledOnce();
  });

  it("completes asynchronous teardown before returning to the outer entrypoint", async () => {
    const order: string[] = [];
    listRegisteredAgentHarnessesMock.mockReturnValueOnce([{ harness: { id: "copilot" } }]);
    hasProviderTransportDispatcherPoolMock.mockReturnValueOnce(true);
    disposeRegisteredAgentHarnessesMock.mockImplementationOnce(async () => {
      order.push("harnesses");
    });
    stopManagedProviderLocalServicesMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      order.push("provider-local-services");
    });
    closeProviderTransportDispatcherPoolMock.mockImplementationOnce(async () => {
      order.push("provider-transport-dispatchers");
    });
    getActiveMcpLoopbackRuntimeMock.mockReturnValueOnce({ port: 1234 });
    closeMcpLoopbackServerMock.mockImplementationOnce(async () => {
      order.push("mcp-loopback");
    });
    hasMemoryRuntimeMock.mockReturnValueOnce(true);
    closeActiveMemorySearchManagersMock.mockImplementationOnce(async () => {
      order.push("memory");
    });
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(cliArgs("models", "status", "--probe"));

    expect(order).toEqual([
      "harnesses",
      "provider-local-services",
      "provider-transport-dispatchers",
      "mcp-loopback",
      "memory",
    ]);
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
  });

  registerRunMainProxyExitTests({
    runCli: (argv) => runCli(argv),
    startProxyMock,
    stopProxyMock,
    tryRouteCliMock,
  });

  it("returns after a handled container-target invocation", async () => {
    const previousExitCode = process.exitCode;
    maybeRunCliInContainerMock.mockReturnValueOnce({ handled: true, exitCode: 7 });

    await runCli(cliArgs("--container", "demo", "status"));

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(
      cliArgs("--container", "demo", "status"),
    );
    expect(enableConsoleCaptureMock).toHaveBeenCalledTimes(1);
    const captureOrder = enableConsoleCaptureMock.mock.invocationCallOrder[0] ?? 0;
    const containerOrder = maybeRunCliInContainerMock.mock.invocationCallOrder[0] ?? 0;
    expect(captureOrder).toBeGreaterThan(0);
    expect(containerOrder).toBeGreaterThan(captureOrder);
    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
    process.exitCode = previousExitCode;
  });

  it("swallows Commander parse exits after recording the exit code", async () => {
    const exitCode = process.exitCode;
    const program = {
      commands: [{ name: () => "status" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(
          new CommanderError(1, "commander.excessArguments", "too many arguments for 'status'"),
        ),
    };
    buildProgramMock.mockReturnValueOnce(program);

    await expect(runCli(cliArgs("status"))).resolves.toBeUndefined();

    expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "status", cliArgs("status")]]);
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCode;
  });

  it("requests a flushed one-shot exit after Commander renders help", async () => {
    const exitCode = process.exitCode;
    const program = {
      commands: [{ name: () => "security" }],
      parseAsync: vi
        .fn()
        .mockRejectedValueOnce(new CommanderError(0, "commander.helpDisplayed", "help displayed")),
    };
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(cliArgs("security", "--help"));

    expect(requestExitAfterOneShotOutputMock).toHaveBeenCalledOnce();
    expect(flushExitAfterOneShotOutputMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    process.exitCode = exitCode;
  });

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
      expect(restoreRuntimeTerminalStateMock).toHaveBeenCalledWith("uncaught exception");
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
      expect(restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
