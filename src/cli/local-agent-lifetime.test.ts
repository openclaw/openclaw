import { describe, expect, it, vi } from "vitest";
import {
  armLocalAgentHardTimeout,
  exitAfterLocalAgentCompletion,
  resolveLocalAgentHardTimeoutPlan,
} from "./local-agent-lifetime.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

const agentLocalArgv = (...args: string[]) => ["node", "openclaw", "agent", "--local", ...args];

describe("resolveLocalAgentHardTimeoutPlan", () => {
  it("ignores non-agent and help invocations", () => {
    expect(resolveLocalAgentHardTimeoutPlan({ argv: ["node", "openclaw", "status"] })).toBeNull();
    expect(
      resolveLocalAgentHardTimeoutPlan({ argv: ["node", "openclaw", "agent", "--help"] }),
    ).toBeNull();
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: ["node", "openclaw", "-v", "agent", "--local", "--timeout", "1"],
      }),
    ).toBeNull();
  });

  it("ignores agent runs that are not local", () => {
    expect(
      resolveLocalAgentHardTimeoutPlan({ argv: ["node", "openclaw", "agent", "--timeout", "2"] }),
    ).toBeNull();
  });

  it("uses explicit timeout seconds plus grace", () => {
    expect(resolveLocalAgentHardTimeoutPlan({ argv: agentLocalArgv("--timeout", "2") })).toEqual({
      timeoutMs: 32_000,
      timeoutSeconds: 2,
    });
    expect(resolveLocalAgentHardTimeoutPlan({ argv: agentLocalArgv("--timeout=1s") })).toEqual({
      timeoutMs: 31_000,
      timeoutSeconds: 1,
    });
    expect(resolveLocalAgentHardTimeoutPlan({ argv: agentLocalArgv("--timeout", "1.5") })).toEqual({
      timeoutMs: 31_000,
      timeoutSeconds: 1,
    });
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: ["node", "openclaw", "--profile", "dev", "agent", "--local", "--timeout", "2"],
      }),
    ).toEqual({
      timeoutMs: 32_000,
      timeoutSeconds: 2,
    });
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: normalizeWindowsArgv(
          [
            "openclaw",
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js",
            "agent",
            "--local",
            "--timeout",
            "2",
          ],
          { platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe" },
        ),
      }),
    ).toEqual({
      timeoutMs: 32_000,
      timeoutSeconds: 2,
    });
  });

  it("clamps the hard timer to Node's timer-safe maximum", () => {
    expect(
      resolveLocalAgentHardTimeoutPlan({ argv: agentLocalArgv("--timeout", "2147484") }),
    ).toEqual({
      timeoutMs: 2_147_000_000,
      timeoutSeconds: 2_147_484,
    });
  });

  it("uses the last repeated timeout option", () => {
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: agentLocalArgv("--timeout", "1", "--timeout", "0"),
      }),
    ).toBeNull();
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: agentLocalArgv("--timeout", "0", "--timeout", "1"),
      }),
    ).toEqual({
      timeoutMs: 31_000,
      timeoutSeconds: 1,
    });
  });

  it("treats explicit zero as no hard timeout", () => {
    expect(resolveLocalAgentHardTimeoutPlan({ argv: agentLocalArgv("--timeout", "0") })).toBeNull();
  });

  it("does not treat option values as help or version requests", () => {
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: agentLocalArgv("--message", "--help", "--timeout", "1"),
      }),
    ).toEqual({
      timeoutMs: 31_000,
      timeoutSeconds: 1,
    });
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: agentLocalArgv("--message=--version", "--timeout=1"),
      }),
    ).toEqual({
      timeoutMs: 31_000,
      timeoutSeconds: 1,
    });
  });

  it("does not arm the wall-clock timer when timeout is omitted", () => {
    expect(
      resolveLocalAgentHardTimeoutPlan({
        argv: agentLocalArgv(),
      }),
    ).toBeNull();
  });
});

describe("armLocalAgentHardTimeout", () => {
  it("exits 124 and reports the resolved timeout when the hard timer fires", async () => {
    const unref = vi.fn();
    let callback: (() => void) | undefined;
    let flushCallback: (() => void) | undefined;
    const setTimeout = vi.fn((cb: () => void, timeoutMs: number) => {
      if (timeoutMs === 31_000) {
        callback = cb;
      } else {
        expect(timeoutMs).toBe(250);
      }
      return { unref };
    });
    const clearTimeout = vi.fn();
    const write = vi.fn((_chunk: string, cb: () => void) => {
      flushCallback = cb;
    });
    const exit = vi.fn();

    armLocalAgentHardTimeout({
      argv: agentLocalArgv("--timeout=1"),
      setTimeout: setTimeout as never,
      clearTimeout: clearTimeout as never,
      stderr: { write } as never,
      exit,
    });

    expect(unref).toHaveBeenCalledOnce();
    expect(callback).toBeDefined();

    callback?.();

    expect(write).toHaveBeenCalledWith(
      "local agent command timed out after 1s plus 30s grace\n",
      expect.any(Function),
    );
    expect(exit).not.toHaveBeenCalled();
    flushCallback?.();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledWith(124);
    expect(clearTimeout).toHaveBeenCalledOnce();
  });
});

describe("exitAfterLocalAgentCompletion", () => {
  it("does nothing outside local agent runs", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const exit = vi.fn(() => {
      throw new Error("exit");
    });

    await exitAfterLocalAgentCompletion({
      argv: ["node", "openclaw", "status"],
      stdout: stdout as never,
      stderr: stderr as never,
      exit: exit as never,
    });

    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("flushes stdout and stderr before exiting after local agent completion", async () => {
    const stdoutCallbacks: Array<() => void> = [];
    const stderrCallbacks: Array<() => void> = [];
    const stdout = { write: vi.fn((_chunk: string, cb: () => void) => stdoutCallbacks.push(cb)) };
    const stderr = { write: vi.fn((_chunk: string, cb: () => void) => stderrCallbacks.push(cb)) };
    const clearTimeout = vi.fn();
    const setTimeout = vi.fn(() => ({ unref: vi.fn() }));
    const exit = vi.fn(() => {
      throw new Error("exit");
    });

    const result = exitAfterLocalAgentCompletion({
      argv: agentLocalArgv(),
      stdout: stdout as never,
      stderr: stderr as never,
      setTimeout: setTimeout as never,
      clearTimeout: clearTimeout as never,
      exit: exit as never,
    });

    expect(exit).not.toHaveBeenCalled();
    stdoutCallbacks[0]?.();
    expect(exit).not.toHaveBeenCalled();
    stderrCallbacks[0]?.();

    await expect(result).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(process.exitCode ?? 0);
    expect(clearTimeout).toHaveBeenCalledTimes(2);
  });
});
