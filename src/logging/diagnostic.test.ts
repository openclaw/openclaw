import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDiagnosticSessionStateCountForTest,
  logSessionStateChange,
  resetDiagnosticStateForTest,
} from "./diagnostic.js";

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
  });

  afterEach(() => {
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    logSessionStateChange({ sessionId: "stale-1", state: "idle" });
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    logSessionStateChange({ sessionId: "fresh-1", state: "idle" });

    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("caps tracked session states to a bounded max", () => {
    for (let i = 0; i < 2001; i += 1) {
      logSessionStateChange({ sessionId: `session-${i}`, state: "idle" });
    }

    expect(getDiagnosticSessionStateCountForTest()).toBe(2000);
  });
});
