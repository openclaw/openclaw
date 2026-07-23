// Plugin command runner tests cover timeout cleanup defaults for host-managed children.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const { runPluginCommandWithTimeout } = await import("./run-command.js");

describe("runPluginCommandWithTimeout", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("reaps the full process tree on timeout by default", async () => {
    const result = await runPluginCommandWithTimeout({
      argv: ["echo", "hello"],
      timeoutMs: 1_000,
      cwd: "/tmp",
      env: { FOO: "bar" },
    });

    expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], {
      timeoutMs: 1_000,
      cwd: "/tmp",
      env: { FOO: "bar" },
      killProcessTree: true,
    });
  });

  it("normalizes timeout stderr when the process tree is terminated", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({
      code: null,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      killed: true,
      termination: "timeout",
    });

    const result = await runPluginCommandWithTimeout({
      argv: ["sleep", "30"],
      timeoutMs: 50,
    });

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "command timed out after 50ms",
    });
  });
});
