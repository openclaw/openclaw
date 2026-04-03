import { describe, expect, it } from "vitest";
import { formatStatusSummary } from "./tui-status-summary.js";
import type { GatewayStatusSummary } from "./tui-types.js";

describe("formatStatusSummary", () => {
  it("includes early-status diagnostics when available", () => {
    const lines = formatStatusSummary({
      runtimeVersion: "2026.3.12",
      heartbeat: {
        agents: [{ agentId: "main", enabled: true, every: "5m", everyMs: 300_000 }],
        diagnostics: {
          latency: {
            dominant: [{ segment: "runToFirstVisible", count: 4 }],
          },
          earlyStatus: {
            guidance: {
              focus: "expand_active_run_status",
              reason:
                "recent_candidates_are_primarily_waiting_on_latency_priority_rather_than_semantics",
            },
            phase2Supplements: {
              sampleCount: 3,
              eligibleCount: 2,
              hitRatePct: 67,
              topSkipReasons: [{ reason: "latency_priority_observe", count: 1 }],
              statusFirstVisibleAvgMs: 820,
              statusFirstVisibleP95Ms: 960,
            },
          },
        },
      },
      sessions: {
        count: 0,
        defaults: { model: "gpt-5.2", contextTokens: 200_000 },
      },
    } satisfies GatewayStatusSummary);

    expect(lines).toContain("Early status:");
    expect(lines).toContain("  Dominant latency: runToFirstVisible x4");
    expect(lines).toContain("  Phase-2 supplements: 2/3 (67%) | status visible 820/960ms");
    expect(lines).toContain("  Top skip: latency_priority_observe x1");
    expect(lines).toContain(
      "  Next: expand_active_run_status | recent_candidates_are_primarily_waiting_on_latency_priority_rather_than_semantics",
    );
  });
});
