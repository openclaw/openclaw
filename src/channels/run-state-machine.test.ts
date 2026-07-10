// Run state machine tests cover channel run lifecycle transitions and terminal states.
import { describe, expect, it, vi } from "vitest";
import { createRunStateMachine } from "./run-state-machine.js";

describe("createRunStateMachine", () => {
  it("resets stale busy fields on init", () => {
    const setStatus = vi.fn();
    createRunStateMachine({ setStatus });
    expect(setStatus).toHaveBeenCalledWith({
      activeRuns: 0,
      busy: false,
      activeRunStartedAt: null,
    });
  });

  it("emits busy status while active and clears when done", () => {
    const setStatus = vi.fn();
    const machine = createRunStateMachine({
      setStatus,
      now: () => 123,
    });
    const handle = machine.onRunStart();
    machine.onRunEnd(handle);
    expect(setStatus.mock.calls).toEqual([
      [{ activeRuns: 0, busy: false, activeRunStartedAt: null }],
      [{ activeRuns: 1, busy: true, lastRunActivityAt: 123, activeRunStartedAt: 123 }],
      [{ activeRuns: 0, busy: false, lastRunActivityAt: 123, activeRunStartedAt: null }],
    ]);
  });

  it("advances the reported run start to the next oldest run when an older run ends", () => {
    const setStatus = vi.fn();
    let clock = 1_000;
    const machine = createRunStateMachine({
      setStatus,
      now: () => clock,
    });
    const first = machine.onRunStart();
    clock = 2_000;
    machine.onRunStart();
    clock = 3_000;
    machine.onRunEnd(first);
    const last = setStatus.mock.calls.at(-1)?.[0];
    expect(last).toEqual({
      activeRuns: 1,
      busy: true,
      lastRunActivityAt: 3_000,
      activeRunStartedAt: 2_000,
    });
  });

  it("keeps the run start time fixed while the heartbeat refreshes activity", () => {
    vi.useFakeTimers();
    try {
      const setStatus = vi.fn();
      let clock = 1_000;
      const machine = createRunStateMachine({
        setStatus,
        heartbeatMs: 60_000,
        now: () => clock,
      });
      machine.onRunStart();
      clock = 1_000 + 26 * 60_000;
      vi.advanceTimersByTime(26 * 60_000);
      const last = setStatus.mock.calls.at(-1)?.[0];
      expect(last).toMatchObject({
        activeRuns: 1,
        busy: true,
        activeRunStartedAt: 1_000,
        lastRunActivityAt: clock,
      });
      machine.deactivate();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops publishing after lifecycle abort", () => {
    const setStatus = vi.fn();
    const abortController = new AbortController();
    const machine = createRunStateMachine({
      setStatus,
      abortSignal: abortController.signal,
      now: () => 999,
    });
    const handle = machine.onRunStart();
    const callsBeforeAbort = setStatus.mock.calls.length;
    abortController.abort();
    machine.onRunEnd(handle);
    expect(setStatus.mock.calls.length).toBe(callsBeforeAbort);
  });
});
