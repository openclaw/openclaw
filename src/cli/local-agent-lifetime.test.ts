import { describe, expect, it, vi } from "vitest";
import {
  armLocalAgentHardTimeout,
  resolveLocalAgentHardTimeoutPlan,
} from "./local-agent-lifetime.js";

const agentLocalArgv = (...args: string[]) => ["node", "openclaw", "agent", "--local", ...args];

describe("resolveLocalAgentHardTimeoutPlan", () => {
  it("ignores non-agent and help invocations", () => {
    expect(resolveLocalAgentHardTimeoutPlan({ argv: ["node", "openclaw", "status"] })).toBeNull();
    expect(
      resolveLocalAgentHardTimeoutPlan({ argv: ["node", "openclaw", "agent", "--help"] }),
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
  });

  it("treats explicit zero as no hard timeout", () => {
    expect(resolveLocalAgentHardTimeoutPlan({ argv: agentLocalArgv("--timeout", "0") })).toBeNull();
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
  it("exits 124 and reports the resolved timeout when the hard timer fires", () => {
    const unref = vi.fn();
    let callback: (() => void) | undefined;
    const setTimeout = vi.fn((cb: () => void, timeoutMs: number) => {
      callback = cb;
      expect(timeoutMs).toBe(31_000);
      return { unref };
    });
    const write = vi.fn();
    const exit = vi.fn();

    armLocalAgentHardTimeout({
      argv: agentLocalArgv("--timeout=1"),
      setTimeout: setTimeout as never,
      stderr: { write } as never,
      exit,
    });

    expect(unref).toHaveBeenCalledOnce();
    expect(callback).toBeDefined();

    callback?.();

    expect(write).toHaveBeenCalledWith("local agent command timed out after 1s plus 30s grace\n");
    expect(exit).toHaveBeenCalledWith(124);
  });
});
