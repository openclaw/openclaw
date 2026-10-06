// Diagnostic session attention tests cover active work summaries for sessions.
import { describe, expect, it } from "vitest";
import { classifySessionAttention } from "./diagnostic-session-attention.js";

describe("classifySessionAttention", () => {
  it.each([false, true])(
    "classifies provider retry waiting until its deadline (expired=%s)",
    (expired) => {
      const classification = classifySessionAttention({
        state: "processing",
        queueDepth: 1,
        activity: {
          activeWorkKind: "embedded_run",
          hasActiveEmbeddedRun: true,
          lastProgressAgeMs: 660_000,
          activeRetryWaitDeadlineAtMs: Date.now() + (expired ? -1000 : 60_000),
        },
        staleMs: 120_000,
        stuckSessionAbortMs: 360_000,
      });
      expect(classification).toMatchObject(
        expired
          ? {
              eventType: "session.stalled",
              reason: "active_work_without_progress",
            }
          : {
              eventType: "session.long_running",
              reason: "provider_retry_wait",
              recoveryEligible: false,
            },
      );
    },
  );
  it.each([
    {
      name: "queued stale state without active work",
      queueDepth: 1,
      activity: {},
      expected: {
        eventType: "session.stuck",
        reason: "queued_work_without_active_run",
        classification: "stale_session_state",
        recoveryEligible: true,
      },
    },
    {
      name: "queued behind active work",
      queueDepth: 1,
      activity: {
        activeWorkKind: "embedded_run" as const,
        lastProgressAgeMs: 10_000,
      },
      expected: {
        eventType: "session.long_running",
        reason: "queued_behind_active_work",
        classification: "long_running",
        activeWorkKind: "embedded_run",
        recoveryEligible: false,
      },
    },
    {
      name: "processing session with orphaned activity is not recoverable",
      state: "processing" as const,
      queueDepth: 1,
      activity: {
        activeWorkKind: "model_call" as const,
        hasActiveEmbeddedRun: false,
        lastProgressAgeMs: 31_000,
      },
      expected: {
        eventType: "session.stalled",
        reason: "active_work_without_progress",
        classification: "stalled_agent_run",
        activeWorkKind: "model_call",
        recoveryEligible: false,
      },
    },
  ])("$name", ({ activity, expected, queueDepth, state }) => {
    expect(
      classifySessionAttention({
        state,
        queueDepth,
        activity,
        staleMs: 30_000,
        stuckSessionAbortMs: 60_000,
      }),
    ).toEqual(expected);
  });
});
