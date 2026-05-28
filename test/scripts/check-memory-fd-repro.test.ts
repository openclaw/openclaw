import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_READY_OUTPUT_MAX_CHARS,
  hasChildExited,
  stopGatewayWithRuntime,
  updateGatewayReadyOutputState,
  waitForGatewayReady,
} from "../../scripts/check-memory-fd-repro.mjs";

describe("check-memory-fd-repro", () => {
  it("treats signaled gateway children as exited", () => {
    expect(hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("fails gateway readiness immediately after signal exits", async () => {
    const child = {
      exitCode: null,
      signalCode: "SIGTERM",
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    };

    await expect(
      waitForGatewayReady({ child, port: 9, logPath: "gateway.log", timeoutMs: 10_000 }),
    ).rejects.toThrow("gateway exited before ready");
  });

  it("does not signal already exited children during gateway cleanup", async () => {
    const child = {
      exitCode: null,
      kill: vi.fn(),
      signalCode: "SIGTERM",
    };
    const findGatewayPidFn = vi.fn(() => null);
    const killProcess = vi.fn();

    await expect(
      stopGatewayWithRuntime({ child, findGatewayPidFn, killProcess, port: 9 }),
    ).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(findGatewayPidFn).toHaveBeenCalledWith(9);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("bounds gateway readiness output while keeping newest logs", () => {
    const first = updateGatewayReadyOutputState({ tail: "abc", readySeen: false }, "def", 8);
    expect(first).toEqual({ tail: "abcdef", readySeen: false });

    const second = updateGatewayReadyOutputState(first, "ghijkl", 8);
    expect(second).toEqual({ tail: "efghijkl", readySeen: false });
    expect(second.tail).toHaveLength(8);
    expect(GATEWAY_READY_OUTPUT_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps readiness after a coalesced noisy chunk truncates the marker", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "", readySeen: false },
      `[gateway] ready\n${"x".repeat(10_000)}`,
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toHaveLength(64);
    expect(state.tail).not.toContain("[gateway] ready");
  });

  it("recognizes readiness split across the existing tail and new chunk", () => {
    const state = updateGatewayReadyOutputState(
      { tail: "[gateway] rea", readySeen: false },
      "dy\n",
      64,
    );

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("[gateway] ready\n");
  });

  it("preserves previous readiness once seen", () => {
    const state = updateGatewayReadyOutputState({ tail: "old", readySeen: true }, "new output", 8);

    expect(state.readySeen).toBe(true);
    expect(state.tail).toBe("w output");
  });
});
