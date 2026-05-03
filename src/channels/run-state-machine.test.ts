import { describe, expect, it, vi } from "vitest";
import { createRunStateMachine } from "./run-state-machine.js";

describe("createRunStateMachine", () => {
  it("resets stale busy fields on init", () => {
    const setStatus = vi.fn();
    createRunStateMachine({ setStatus });
    expect(setStatus).toHaveBeenCalledWith({ activeRuns: 0, busy: false });
  });

  it("emits busy status while active and clears when done", () => {
    const setStatus = vi.fn();
    const machine = createRunStateMachine({
      setStatus,
      now: () => 123,
    });
    machine.onRunStart();
    machine.onRunEnd();
    expect(setStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        activeRuns: 1,
        busy: true,
        lastRunActivityAt: 123,
      }),
    );
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeRuns: 0,
        busy: false,
        lastRunActivityAt: 123,
      }),
    );
  });

  it("stops publishing after lifecycle abort", () => {
    const setStatus = vi.fn();
    const abortController = new AbortController();
    const machine = createRunStateMachine({
      setStatus,
      abortSignal: abortController.signal,
      now: () => 999,
    });
    machine.onRunStart();
    const callsBeforeAbort = setStatus.mock.calls.length;
    abortController.abort();
    machine.onRunEnd();
    expect(setStatus.mock.calls.length).toBe(callsBeforeAbort);
  });

  it("clamps activeRuns to zero when onRunEnd is called without a matching onRunStart", () => {
    const setStatus = vi.fn();
    const machine = createRunStateMachine({ setStatus, now: () => 1 });

    machine.onRunEnd();

    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRuns: 0, busy: false }),
    );
  });

  it("clamps activeRuns to zero when onRunEnd is called more times than onRunStart", () => {
    const setStatus = vi.fn();
    const machine = createRunStateMachine({ setStatus, now: () => 1 });

    machine.onRunStart();
    machine.onRunEnd();
    machine.onRunEnd(); // extra call — should not go negative

    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeRuns: 0, busy: false }),
    );
  });
});
