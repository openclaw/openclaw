import { describe, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import type { SessionWatchdogDecision } from "../sessions/session-controller.watchdog-state.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const blockedToolCall: SessionAttentionClassification = {
  eventType: "session.stalled",
  reason: "blocked_tool_call",
  classification: "blocked_tool_call",
  activeWorkKind: "tool_call",
};

const stopDecision: SessionWatchdogDecision = { action: "stop", reason: "semantic_stall" };

/** Minimal watchdog stub whose tick settles with the supplied decision. */
function stubOperation(tick: SessionWatchdogDecision = stopDecision) {
  return {
    watchdog: {
      decide: vi.fn(() => tick),
      tick: vi.fn(async () => tick),
      snapshot: vi.fn(() => ({ recovery: { status: "settled", startedAtMs: 0 } })),
    },
  } as unknown as ReplyOperation;
}

const recover = (operation: ReplyOperation, classification?: SessionAttentionClassification) =>
  recoverStuckDiagnosticSession({
    sessionId: "s",
    sessionKey: "k",
    ageMs: 0,
    operation,
    ...(classification ? { classification } : {}),
  });

describe("stuck-session recovery preserves the classification cause (#138528)", () => {
  it("aborts with the classification cause and records it on the controller operation", async () => {
    const operation = stubOperation();
    await expect(recover(operation, blockedToolCall)).resolves.toMatchObject({
      status: "aborted",
      reason: "blocked_tool_call",
    });
    expect(operation.recoveryClassification).toBe("blocked_tool_call");
  });

  it("falls back to the watchdog decision reason when no classification is supplied", async () => {
    await expect(recover(stubOperation())).resolves.toMatchObject({
      status: "aborted",
      reason: "semantic_stall",
    });
  });

  it("keeps the cause off the operation when recovery settles without an abort", async () => {
    const operation = stubOperation({ action: "observe", reason: "model_recovery" });
    await expect(recover(operation, blockedToolCall)).resolves.toMatchObject({ status: "skipped" });
    expect(operation.recoveryClassification).toBeUndefined();
  });

  it("commits the cause before cancellation when the watchdog returns blocked", async () => {
    const operation = stubOperation({ action: "blocked", reason: "exception" });
    await expect(recover(operation, blockedToolCall)).resolves.toMatchObject({ status: "failed" });
    expect(operation.recoveryClassification).toBe("blocked_tool_call");
  });
});
