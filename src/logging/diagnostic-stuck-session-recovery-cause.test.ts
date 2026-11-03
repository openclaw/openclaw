import { describe, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import { requestStuckSessionRecovery } from "./diagnostic-session-recovery-coordinator.js";
import { formatRecoveryOutcome } from "./diagnostic-session-recovery.js";
import type { StuckSessionRecoveryOutcome } from "./diagnostic-session-recovery.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const blockedToolCall: SessionAttentionClassification = {
  eventType: "session.stalled",
  reason: "blocked_tool_call",
  classification: "blocked_tool_call",
  activeWorkKind: "tool_call",
};

/** Minimal watchdog stub that settles with a stop decision. */
function stubOperation(): ReplyOperation {
  return {
    watchdog: {
      decide: vi.fn(() => ({ action: "stop", reason: "semantic_stall" })),
      tick: vi.fn(async () => ({ action: "stop", reason: "semantic_stall" })),
      snapshot: vi.fn(() => ({ recovery: { status: "settled", startedAtMs: 0 } })),
    },
  } as unknown as ReplyOperation;
}

describe("stuck-session recovery preserves the classification cause (#138528)", () => {
  it("carries the blocked_tool_call classification onto the aborted outcome", async () => {
    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "s",
      sessionKey: "k",
      ageMs: 0,
      operation: stubOperation(),
      classification: blockedToolCall,
    });
    expect(outcome).toMatchObject({ status: "aborted", reason: "blocked_tool_call" });
  });

  it("falls back to the watchdog decision reason when no classification is supplied", async () => {
    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "s",
      sessionKey: "k",
      ageMs: 0,
      operation: stubOperation(),
    });
    expect(outcome).toMatchObject({ status: "aborted", reason: "semantic_stall" });
  });

  it("records the semantic cause on the controller-owned operation so run finalization can surface it", async () => {
    const op = stubOperation();
    await recoverStuckDiagnosticSession({
      sessionId: "s",
      sessionKey: "k",
      ageMs: 0,
      operation: op,
      classification: blockedToolCall,
    });
    // Read from the same controller-owned operation instance cron finalization reads.
    expect(op.recoveryClassification).toBe("blocked_tool_call");
  });

  it("does not record a classification when the recovery does not abort", async () => {
    const op = stubOperation();
    // observe/keep_lane path (model_recovery) returns a skipped outcome.
    vi.spyOn(op.watchdog, "tick").mockResolvedValue({
      action: "observe",
      reason: "model_recovery",
    });
    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "s",
      sessionKey: "k",
      ageMs: 0,
      operation: op,
      classification: blockedToolCall,
    });
    expect(outcome.status).not.toBe("aborted");
    expect(op.recoveryClassification).toBeUndefined();
  });

  it("prints the cause for the aborted branch instead of a cause-free literal", () => {
    const outcome: StuckSessionRecoveryOutcome = {
      status: "aborted",
      action: "abort_embedded_run",
      sessionId: "s",
      sessionKey: "k",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 0,
      reason: "blocked_tool_call",
    };
    expect(formatRecoveryOutcome(outcome)).toContain("reason=blocked_tool_call");
  });

  it("coordinator forwards the classification into the recovery request", async () => {
    const captured: Array<unknown> = [];
    requestStuckSessionRecovery({
      classification: blockedToolCall,
      request: {
        sessionId: "s",
        sessionKey: "k",
        ageMs: 0,
        operation: stubOperation(),
      },
      recover: (resolved) => {
        captured.push(resolved);
        return undefined;
      },
    });
    // recover is invoked synchronously when the watchdog decision admits a stop.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ classification: blockedToolCall });
  });
});
