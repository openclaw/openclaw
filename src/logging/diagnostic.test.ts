import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionStateCountForTest,
  getDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  logSessionStateChange,
  resetDiagnosticStateForTest,
  resolveStuckSessionAutoRecoverMs,
  resolveStuckSessionWarnMs,
  startDiagnosticHeartbeat,
} from "./diagnostic.js";

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("caps tracked session states to a bounded max", () => {
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      diagnosticSessionStates.set(`session-${i}`, {
        sessionId: `session-${i}`,
        lastActivity: now + i,
        state: "idle",
        queueDepth: 1,
      });
    }
    pruneDiagnosticSessionStates(now + 2002, true);

    expect(getDiagnosticSessionStateCountForTest()).toBe(2000);
  });

  it("reuses keyed session state when later looked up by sessionId", () => {
    const keyed = getDiagnosticSessionState({
      sessionId: "s1",
      sessionKey: "agent:main:discord:channel:c1",
    });
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });

    expect(bySessionId).toBe(keyed);
    expect(bySessionId.sessionKey).toBe("agent:main:discord:channel:c1");
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });
});

describe("logger import side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not mkdir at import time", async () => {
    vi.useRealTimers();
    vi.resetModules();

    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    await import("./logger.js");

    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});

describe("stuck session diagnostics threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("uses the configured diagnostics.stuckSessionWarnMs threshold", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(1);
  });

  it("falls back to default threshold when config is absent", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat();
      logSessionStateChange({ sessionId: "s2", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(31_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
  });

  it("uses default threshold for invalid values", () => {
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: -1 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: 0 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs()).toBe(120_000);
  });
});

describe("stuck session auto-recovery threshold", () => {
  it("returns default when config is absent", () => {
    expect(resolveStuckSessionAutoRecoverMs()).toBe(300_000);
    expect(resolveStuckSessionAutoRecoverMs({})).toBe(300_000);
  });

  it("returns null when explicitly disabled with 0", () => {
    expect(
      resolveStuckSessionAutoRecoverMs({ diagnostics: { stuckSessionAutoRecoverMs: 0 } }),
    ).toBeNull();
  });

  it("uses configured value when valid", () => {
    expect(
      resolveStuckSessionAutoRecoverMs({ diagnostics: { stuckSessionAutoRecoverMs: 60_000 } }),
    ).toBe(60_000);
  });

  it("clamps to default when below minimum", () => {
    expect(
      resolveStuckSessionAutoRecoverMs({ diagnostics: { stuckSessionAutoRecoverMs: 1_000 } }),
    ).toBe(300_000);
  });

  it("clamps to max when above ceiling", () => {
    const overMax = 25 * 60 * 60 * 1000;
    expect(
      resolveStuckSessionAutoRecoverMs({ diagnostics: { stuckSessionAutoRecoverMs: overMax } }),
    ).toBe(24 * 60 * 60 * 1000);
  });
});

describe("stuck session auto-recovery in heartbeat", () => {
  // Pre-warm the dynamic import so .then() resolves synchronously in fake-timer tests.
  beforeAll(async () => {
    await import("../agents/pi-embedded-runner/runs.js");
  });

  beforeEach(() => {
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });

  it("emits session.auto_recover after threshold exceeded", async () => {
    const events: Array<{ type: string; sessionId?: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if ("sessionId" in event) {
        events.push({ type: event.type, sessionId: event.sessionId });
      } else {
        events.push({ type: event.type });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 10_000,
          stuckSessionAutoRecoverMs: 60_000,
        },
      });
      logSessionStateChange({ sessionId: "stuck-1", sessionKey: "main", state: "processing" });

      // Advance past warn threshold but before auto-recover
      await vi.advanceTimersByTimeAsync(31_000);
      const stuckBeforeRecover = events.filter((e) => e.type === "session.stuck");
      expect(stuckBeforeRecover.length).toBeGreaterThanOrEqual(1);
      expect(events.filter((e) => e.type === "session.auto_recover")).toHaveLength(0);

      // Advance past auto-recover threshold
      await vi.advanceTimersByTimeAsync(60_000);

      const recoveryEvents = events.filter((e) => e.type === "session.auto_recover");
      expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);
      expect(recoveryEvents[0]?.sessionId).toBe("stuck-1");
    } finally {
      unsubscribe();
    }
  });

  it("does not auto-recover probe sessions", async () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 5_000,
          stuckSessionAutoRecoverMs: 30_000,
        },
      });
      logSessionStateChange({
        sessionId: "probe-health",
        sessionKey: "probe",
        state: "processing",
      });

      await vi.advanceTimersByTimeAsync(91_000);

      expect(events.filter((e) => e.type === "session.auto_recover")).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("does not auto-recover when disabled with 0", async () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 5_000,
          stuckSessionAutoRecoverMs: 0,
        },
      });
      logSessionStateChange({ sessionId: "stuck-2", sessionKey: "main", state: "processing" });

      await vi.advanceTimersByTimeAsync(600_000);

      expect(events.filter((e) => e.type === "session.auto_recover")).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("only auto-recovers a session once when abort succeeds", async () => {
    const runsModule = await import("../agents/pi-embedded-runner/runs.js");
    const abortSpy = vi.spyOn(runsModule, "abortEmbeddedPiRun").mockReturnValue(true);

    const events: Array<{ type: string; sessionId?: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if ("sessionId" in event) {
        events.push({ type: event.type, sessionId: event.sessionId });
      } else {
        events.push({ type: event.type });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 5_000,
          stuckSessionAutoRecoverMs: 30_000,
        },
      });
      logSessionStateChange({ sessionId: "stuck-3", sessionKey: "main", state: "processing" });

      await vi.advanceTimersByTimeAsync(120_000);

      const recoveryEvents = events.filter((e) => e.type === "session.auto_recover");
      expect(recoveryEvents).toHaveLength(1);
    } finally {
      unsubscribe();
      abortSpy.mockRestore();
    }
  });

  it("retries auto-recovery when no active run was found", async () => {
    const runsModule = await import("../agents/pi-embedded-runner/runs.js");
    const abortSpy = vi.spyOn(runsModule, "abortEmbeddedPiRun").mockReturnValue(false);

    const events: Array<{ type: string; sessionId?: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if ("sessionId" in event) {
        events.push({ type: event.type, sessionId: event.sessionId });
      } else {
        events.push({ type: event.type });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 5_000,
          stuckSessionAutoRecoverMs: 30_000,
        },
      });
      logSessionStateChange({ sessionId: "stuck-4", sessionKey: "main", state: "processing" });

      await vi.advanceTimersByTimeAsync(120_000);

      const recoveryEvents = events.filter((e) => e.type === "session.auto_recover");
      expect(recoveryEvents.length).toBeGreaterThan(1);
    } finally {
      unsubscribe();
      abortSpy.mockRestore();
    }
  });
});
