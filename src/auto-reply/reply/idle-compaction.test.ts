/**
 * Tests for idle-triggered proactive compaction.
 *
 * Covers:
 * - idleTriggerMinutes not configured → no timer
 * - context below threshold → no timer
 * - context >= threshold with idleTriggerMinutes → timer fires → compactEmbeddedPiSession called
 * - new message (cancelIdleCompaction) → timer cleared, compact not called
 * - schema validation: invalid values rejected
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (must be hoisted before imports that trigger module load) ──────────

const state = vi.hoisted(() => ({
  compactMock: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  compactEmbeddedPiSession: (params: unknown) => state.compactMock(params),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
  },
}));

import { AgentDefaultsSchema } from "../../config/zod-schema.agent-defaults.js";
import { cancelIdleCompaction, scheduleIdleCompaction } from "./idle-compaction.js";
import type { ScheduleIdleCompactionParams } from "./idle-compaction.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(
  overrides: Partial<ScheduleIdleCompactionParams> & {
    idleTriggerMinutes?: number;
    idleTriggerPercent?: number;
  } = {},
): ScheduleIdleCompactionParams {
  const { idleTriggerMinutes, idleTriggerPercent, ...rest } = overrides;

  return {
    sessionKey: "test-session",
    sessionId: "session-uuid-1",
    contextTokensUsed: 80_000,
    contextTokensMax: 100_000,
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    provider: "anthropic",
    model: "claude",
    cfg: {
      agents: {
        defaults: {
          compaction: {
            ...(idleTriggerMinutes !== undefined ? { idleTriggerMinutes } : {}),
            ...(idleTriggerPercent !== undefined ? { idleTriggerPercent } : {}),
          },
        },
      },
    } as unknown as ScheduleIdleCompactionParams["cfg"],
    ...rest,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("scheduleIdleCompaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.compactMock.mockReset();
    state.compactMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    // Clean up any lingering timers.
    cancelIdleCompaction("test-session");
    cancelIdleCompaction("other-session");
    vi.useRealTimers();
  });

  it("does NOT set a timer when idleTriggerMinutes is not configured", async () => {
    scheduleIdleCompaction(makeParams()); // no idleTriggerMinutes

    await vi.runAllTimersAsync();

    expect(state.compactMock).not.toHaveBeenCalled();
  });

  it("does NOT set a timer when context is below threshold (default 0.7)", async () => {
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 5,
        contextTokensUsed: 60_000, // 60% — below default 70%
        contextTokensMax: 100_000,
      }),
    );

    await vi.runAllTimersAsync();

    expect(state.compactMock).not.toHaveBeenCalled();
  });

  it("does NOT set a timer when context is below a custom threshold", async () => {
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 5,
        idleTriggerPercent: 0.9,
        contextTokensUsed: 80_000, // 80% — below custom 90%
        contextTokensMax: 100_000,
      }),
    );

    await vi.runAllTimersAsync();

    expect(state.compactMock).not.toHaveBeenCalled();
  });

  it("fires compactEmbeddedPiSession after the timer when context >= threshold", async () => {
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 5,
        contextTokensUsed: 75_000, // 75% — above default 70%
        contextTokensMax: 100_000,
      }),
    );

    // Timer should not have fired yet.
    expect(state.compactMock).not.toHaveBeenCalled();

    // Advance by exactly 5 minutes.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(state.compactMock).toHaveBeenCalledOnce();
    expect(state.compactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-uuid-1",
        sessionKey: "test-session",
        trigger: "manual",
      }),
    );
  });

  it("fires at exactly the custom threshold boundary (>=)", async () => {
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 2,
        idleTriggerPercent: 0.8,
        contextTokensUsed: 80_000, // exactly 80%
        contextTokensMax: 100_000,
      }),
    );

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(state.compactMock).toHaveBeenCalledOnce();
  });

  it("does NOT fire when timer is cancelled before it expires", async () => {
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 5,
        contextTokensUsed: 80_000,
        contextTokensMax: 100_000,
      }),
    );

    // Simulate a new inbound message arriving — cancel the timer.
    cancelIdleCompaction("test-session");

    await vi.runAllTimersAsync();

    expect(state.compactMock).not.toHaveBeenCalled();
  });

  it("replaces an earlier timer when called again before the first fires", async () => {
    // First schedule
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 5,
        sessionId: "session-uuid-1",
        contextTokensUsed: 80_000,
        contextTokensMax: 100_000,
      }),
    );

    // Advance partway.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    // Second schedule (context still above threshold)
    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 5,
        sessionId: "session-uuid-2", // different session id to verify which one fires
        contextTokensUsed: 85_000,
        contextTokensMax: 100_000,
      }),
    );

    // Let the second timer fire.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // Only one compaction should have run (the second).
    expect(state.compactMock).toHaveBeenCalledOnce();
    expect(state.compactMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-uuid-2" }),
    );
  });

  it("silently catches errors from compactEmbeddedPiSession (best-effort)", async () => {
    state.compactMock.mockRejectedValueOnce(new Error("compact failed"));

    scheduleIdleCompaction(
      makeParams({
        idleTriggerMinutes: 1,
        contextTokensUsed: 80_000,
        contextTokensMax: 100_000,
      }),
    );

    // Should not throw even when compactEmbeddedPiSession rejects.
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
    expect(state.compactMock).toHaveBeenCalledOnce();
  });
});

describe("cancelIdleCompaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.compactMock.mockReset();
    state.compactMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cancelIdleCompaction("test-session");
    vi.useRealTimers();
  });

  it("is a no-op when no timer is pending", () => {
    expect(() => cancelIdleCompaction("no-such-session")).not.toThrow();
  });
});

// ── Zod schema validation ────────────────────────────────────────────────────

describe("AgentDefaultsSchema — compaction.idleTrigger* validation", () => {
  function parseCompaction(compaction: Record<string, unknown>) {
    return AgentDefaultsSchema?.safeParse({ compaction });
  }

  it("accepts valid idleTriggerMinutes (positive integer)", () => {
    const result = parseCompaction({ idleTriggerMinutes: 5 });
    expect(result?.success).toBe(true);
  });

  it("rejects idleTriggerMinutes = 0", () => {
    const result = parseCompaction({ idleTriggerMinutes: 0 });
    expect(result?.success).toBe(false);
  });

  it("rejects negative idleTriggerMinutes", () => {
    const result = parseCompaction({ idleTriggerMinutes: -1 });
    expect(result?.success).toBe(false);
  });

  it("rejects non-integer idleTriggerMinutes", () => {
    const result = parseCompaction({ idleTriggerMinutes: 1.5 });
    expect(result?.success).toBe(false);
  });

  it("accepts valid idleTriggerPercent (0.1–0.95)", () => {
    const result = parseCompaction({ idleTriggerPercent: 0.75 });
    expect(result?.success).toBe(true);
  });

  it("accepts idleTriggerPercent at min boundary (0.1)", () => {
    const result = parseCompaction({ idleTriggerPercent: 0.1 });
    expect(result?.success).toBe(true);
  });

  it("accepts idleTriggerPercent at max boundary (0.95)", () => {
    const result = parseCompaction({ idleTriggerPercent: 0.95 });
    expect(result?.success).toBe(true);
  });

  it("rejects idleTriggerPercent < 0.1", () => {
    const result = parseCompaction({ idleTriggerPercent: 0.05 });
    expect(result?.success).toBe(false);
  });

  it("rejects idleTriggerPercent > 0.95", () => {
    const result = parseCompaction({ idleTriggerPercent: 0.96 });
    expect(result?.success).toBe(false);
  });
});
