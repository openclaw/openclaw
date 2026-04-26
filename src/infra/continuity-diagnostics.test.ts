import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  subsystem: "continuity/diagnostics",
  isEnabled: vi.fn(() => true),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => logger),
}));

import { onAgentEvent, resetAgentEventsForTest } from "./agent-events.js";
import { __testing, emitContinuityDiagnostic } from "./continuity-diagnostics.js";

describe("continuity-diagnostics", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    vi.clearAllMocks();
  });

  it("normalizes, logs, returns, and emits diagnostic data", () => {
    const events: Array<{ runId: string; stream: string; sessionKey?: string; data: unknown }> = [];
    const stop = onAgentEvent((event) => {
      events.push({
        runId: event.runId,
        stream: event.stream,
        sessionKey: event.sessionKey,
        data: event.data,
      });
    });

    const data = emitContinuityDiagnostic({
      type: " diag.approval.carry_mismatch ",
      severity: "error",
      phase: " before_decision_use ",
      sessionKey: " session-main ",
      correlation: {
        approvalId: " approval-1 ",
        ignored: undefined,
        approvalKind: "exec",
      },
      details: {
        reason: "live_pending_missing",
        skipped: undefined,
      },
    });

    stop();

    expect(data).toEqual({
      type: "diag.approval.carry_mismatch",
      severity: "error",
      phase: "before_decision_use",
      sessionKey: "session-main",
      correlation: {
        approvalId: " approval-1 ",
        approvalKind: "exec",
      },
      details: {
        reason: "live_pending_missing",
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[diagnostic] diag.approval.carry_mismatch phase=before_decision_use sessionKey=session-main",
      data,
    );
    expect(events).toEqual([
      {
        runId: "approval-1",
        stream: "diagnostic",
        sessionKey: "session-main",
        data,
      },
    ]);
  });

  it("defaults to warn severity and uses session/type fallback run ids", () => {
    const events: Array<{ runId: string; data: unknown }> = [];
    const stop = onAgentEvent((event) => {
      events.push({ runId: event.runId, data: event.data });
    });

    const withSession = emitContinuityDiagnostic({
      type: "diag.outbound.target_reresolved",
      sessionKey: "session-delivery",
    });
    const withoutSession = emitContinuityDiagnostic({
      type: "   ",
    });

    stop();

    expect(withSession).toEqual({
      type: "diag.outbound.target_reresolved",
      severity: "warn",
      sessionKey: "session-delivery",
    });
    expect(withoutSession).toEqual({
      type: "diag.unknown",
      severity: "warn",
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.runId)).toEqual([
      "session-delivery",
      "diag.unknown",
    ]);
  });

  it("logs info diagnostics through the info logger", () => {
    const data = emitContinuityDiagnostic({
      type: "continuity.restore.boundary_freshened",
      severity: "info",
      runId: "run-1",
      correlation: { boundaryId: "boundary-1" },
    });

    expect(logger.info).toHaveBeenCalledWith(
      "[diagnostic] continuity.restore.boundary_freshened",
      data,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps helper normalizers small and predictable", () => {
    expect(__testing.cleanString(" value ")).toBe("value");
    expect(__testing.cleanString("   ")).toBeUndefined();
    expect(__testing.normalizeSeverity("debug")).toBe("warn");
    expect(__testing.compactObject({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
    expect(__testing.compactObject(["nope"])).toBeUndefined();
  });
});
