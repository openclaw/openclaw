// Drain-time one-tier aging so lower-priority work is not starved forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "./command-queue.js";
import { pickNextAmongHeads } from "./command-queue.priority.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import { CommandLane, STARVATION_PROMOTION_MS } from "./lanes.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function enqueueBlockedMainTask(): { release: () => void } {
  const deferred = createDeferred();
  void enqueueCommandInLane(CommandLane.Main, async () => {
    await deferred.promise;
  });
  return { release: deferred.resolve };
}

describe("command queue starvation promotion", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
  });

  it("preserves foreground priority over aged background work", async () => {
    vi.useFakeTimers();
    const { release } = enqueueBlockedMainTask();
    const calls: string[] = [];

    const bgTask = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("background");
      },
      { priority: "background" },
    );

    vi.advanceTimersByTime(STARVATION_PROMOTION_MS + 1);

    const fgTask = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("foreground");
      },
      { priority: "foreground" },
    );

    release();
    await Promise.all([bgTask, fgTask]);
    expect(calls).toEqual(["foreground", "background"]);
  });

  it("preserves foreground priority over aged default-normal work", async () => {
    vi.useFakeTimers();
    const { release } = enqueueBlockedMainTask();
    const calls: string[] = [];

    const agedNormal = enqueueCommandInLane(CommandLane.Main, async () => {
      calls.push("aged-normal");
    });

    vi.advanceTimersByTime(STARVATION_PROMOTION_MS + 1);

    const fgTask = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("foreground");
      },
      { priority: "foreground" },
    );

    release();
    await Promise.all([agedNormal, fgTask]);
    expect(calls).toEqual(["foreground", "aged-normal"]);
  });

  it("promotes aged background above fresh background", async () => {
    vi.useFakeTimers();
    const { release } = enqueueBlockedMainTask();
    const calls: string[] = [];

    const agedBg = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("aged-bg");
      },
      { priority: "background" },
    );

    vi.advanceTimersByTime(STARVATION_PROMOTION_MS + 1);

    const freshBg = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("fresh-bg");
      },
      { priority: "background" },
    );

    release();
    await Promise.all([agedBg, freshBg]);
    expect(calls).toEqual(["aged-bg", "fresh-bg"]);
  });

  it("drains aged background before a later default-normal at drain time", async () => {
    vi.useFakeTimers();
    const { release } = enqueueBlockedMainTask();
    const calls: string[] = [];

    const agedBg = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        calls.push("aged-bg");
      },
      { priority: "background" },
    );

    vi.advanceTimersByTime(STARVATION_PROMOTION_MS + 1);

    const freshNormal = enqueueCommandInLane(CommandLane.Main, async () => {
      calls.push("fresh-normal");
    });

    release();
    await Promise.all([agedBg, freshNormal]);
    expect(calls).toEqual(["aged-bg", "fresh-normal"]);
  });
});

describe("pickNextAmongHeads sequence ties", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers global sequence when wall clocks go backward", () => {
    const older = { id: "a", priority: 0, enqueuedAt: 1_000, sequence: 1 };
    const newer = { id: "b", priority: 0, enqueuedAt: 100, sequence: 2 };
    expect(pickNextAmongHeads([newer, older])?.id).toBe("a");
    expect(pickNextAmongHeads([older, newer])?.id).toBe("a");
  });

  it("prefers global sequence when aged background ties fresh normal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const agedBackground = {
      id: "aged-bg",
      priority: -1,
      enqueuedAt: 50_000 - STARVATION_PROMOTION_MS - 1,
      sequence: 1,
    };
    const freshNormal = { id: "fresh-normal", priority: 0, enqueuedAt: 1, sequence: 2 };
    expect(pickNextAmongHeads([freshNormal, agedBackground])?.id).toBe("aged-bg");
    expect(pickNextAmongHeads([agedBackground, freshNormal])?.id).toBe("aged-bg");
  });
});
