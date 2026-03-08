import { describe, expect, it } from "vitest";
import { __testing } from "./get-reply-inline-actions.js";

describe("get-reply-inline-actions eval ids", () => {
  it("extracts trace, run, scenario, and revision ids from skill args", () => {
    const ids = __testing.extractEvalIds(
      "trace_id=mem-eval-001 run_id=2026-03-08T10:30:00Z scenario_id=recap-auth-resume code_revision=git:abc123 plugin_revision=hash:def456",
    );

    expect(ids).toEqual({
      traceId: "mem-eval-001",
      runId: "2026-03-08T10:30:00Z",
      scenarioId: "recap-auth-resume",
      codeRevision: "git:abc123",
      pluginRevision: "hash:def456",
    });
  });

  it("supports JSON-like trace markers", () => {
    const ids = __testing.extractEvalIds(
      '{"trace_id":"mem-eval-002","scenario_id":"intake-decision-auth-rotation","code_revision":"git:def789"}',
    );

    expect(ids.traceId).toBe("mem-eval-002");
    expect(ids.scenarioId).toBe("intake-decision-auth-rotation");
    expect(ids.codeRevision).toBe("git:def789");
  });
});
