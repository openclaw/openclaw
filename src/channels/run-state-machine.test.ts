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

  it("keeps zero-argument lifecycle callbacks compatible", () => {
    const setStatus = vi.fn();
    const machine = createRunStateMachine({
      setStatus,
      now: () => 123,
    });
    machine.onRunStart();
    machine.onRunEnd();
    expect(setStatus.mock.calls).toEqual([
      [{ activeRuns: 0, busy: false, activeRunStartedAt: null }],
      [{ activeRuns: 1, busy: true, lastRunActivityAt: 123, activeRunStartedAt: null }],
      [{ activeRuns: 0, busy: false, lastRunActivityAt: 123, activeRunStartedAt: null }],
    ]);
  });

  it("does not publish a run start for concurrent anonymous runs", () => {
    const setStatus = vi.fn();
    let clock = 1_000;
    const machine = createRunStateMachine({
      setStatus,
      now: () => clock,
    });
    machine.onRunStart();
    clock = 2_000;
    machine.onRunStart();
    clock = 3_000;
    machine.onRunEnd();

    expect(setStatus.mock.calls.at(-1)?.[0]).toEqual({
      activeRuns: 1,
      busy: true,
      lastRunActivityAt: 3_000,
      activeRunStartedAt: null,
    });
  });

  it("keeps the oldest reported run start when a newer tracked run ends", () => {
    const setStatus = vi.fn();
    let clock = 1_000;
    const machine = createRunStateMachine({
      setStatus,
      now: () => clock,
    });
    machine.onTrackedRunStart();
    clock = 2_000;
    const second = machine.onTrackedRunStart();
    clock = 3_000;
    machine.onTrackedRunEnd(second);

    expect(setStatus.mock.calls.at(-1)?.[0]).toEqual({
      activeRuns: 1,
      busy: true,
      lastRunActivityAt: 3_000,
      activeRunStartedAt: 1_000,
    });
  });

  it("advances the reported run start to the next oldest run when an older run ends", () => {
    const setStatus = vi.fn();
    let clock = 1_000;
    const machine = createRunStateMachine({
      setStatus,
      now: () => clock,
    });
    const first = machine.onTrackedRunStart();
    clock = 2_000;
    machine.onTrackedRunStart();
    clock = 3_000;
    machine.onTrackedRunEnd(first);
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
      machine.onTrackedRunStart();
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
    const handle = machine.onTrackedRunStart();
    const callsBeforeAbort = setStatus.mock.calls.length;
    abortController.abort();
    machine.onTrackedRunEnd(handle);
    expect(setStatus.mock.calls.length).toBe(callsBeforeAbort);
  });
});
