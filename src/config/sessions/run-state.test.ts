import { describe, expect, it } from "vitest";
import { applyKilledSessionEntryState, type SessionEntry } from "../sessions.js";

describe("applyKilledSessionEntryState", () => {
  it("does not set abortedLastRun unless explicitly requested", () => {
    const nowMs = 1_700_000_000_000;
    const entry: SessionEntry = {
      sessionId: "session-a",
      updatedAt: nowMs - 10_000,
      status: "running",
      startedAt: nowMs - 40_000,
    };

    applyKilledSessionEntryState(entry, { nowMs });

    expect(entry.status).toBe("killed");
    expect(entry.abortedLastRun).toBeUndefined();
    expect(entry.endedAt).toBe(nowMs);
    expect(entry.runtimeMs).toBe(40_000);
  });

  it("sets abortedLastRun when explicitly requested", () => {
    const nowMs = 1_700_000_000_000;
    const entry: SessionEntry = {
      sessionId: "session-b",
      updatedAt: nowMs - 5_000,
      status: "running",
      startedAt: nowMs - 15_000,
    };

    applyKilledSessionEntryState(entry, { nowMs, markAbortedLastRun: true });

    expect(entry.status).toBe("killed");
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.endedAt).toBe(nowMs);
    expect(entry.runtimeMs).toBe(15_000);
  });
});
