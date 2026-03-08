import { describe, expect, it } from "vitest";
import {
  createSeedActualEntries,
  scoreActualResults,
  type ActualResult,
  type Scenario,
} from "../evals/run-memory-evals.ts";
import { createTraceId } from "../evals/memory-run-context.ts";

const gold: Scenario[] = [
  {
    id: "recap-auth-resume",
    category: "recap",
    transcript: [{ role: "user", content: "Recap auth task" }],
    expected: {
      skill: "memory-recap",
      action: "recap",
      classifications: [],
      conflictFlag: false,
      memoryCreates: 0,
      memoryIdsRequired: false,
      recapMustInclude: ["current task", "next best action"],
      evolutionMode: "none",
    },
    kpis: ["recap_hit_rate"],
  },
  {
    id: "evolution-safe-propose",
    category: "evolution",
    transcript: [{ role: "user", content: "Propose only" }],
    expected: {
      skill: "memory-evolution",
      action: "propose",
      classifications: [],
      conflictFlag: false,
      memoryCreates: 0,
      memoryIdsRequired: false,
      recapMustInclude: [],
      evolutionMode: "propose-only",
    },
    kpis: ["false_apply_zero"],
  },
];

describe("memory eval runner", () => {
  it("seeds actual entries with run, scenario, bucket, and trace ids", () => {
    const runId = "2026-03-08T10:30:00.000Z";
    const rows = createSeedActualEntries(gold, runId, {
      codeRevision: "git:abc123",
      pluginRevision: "hash:def456",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      run_id: runId,
      scenario_id: "recap-auth-resume",
      bucket: "recap_hit_rate",
      skill_expected: "memory-recap",
      code_revision: "git:abc123",
      plugin_revision: "hash:def456",
    });
    expect(rows[0]?.trace_id).toBe(createTraceId(runId, "recap-auth-resume"));
    expect(rows[0]?.run_context?.traceId).toBe(createTraceId(runId, "recap-auth-resume"));
  });

  it("uses nested run_context for trace propagation checks", () => {
    const runId = "2026-03-08T10:30:00.000Z";
    const actualRows: ActualResult[] = [
      {
        scenario_id: "recap-auth-resume",
        skill_expected: "memory-recap",
        skill_actual: "memory-intake",
        run_context: {
          runId,
          traceId: "trace-nested-1",
          mode: "eval",
          scenarioId: "recap-auth-resume",
        },
        actual: {
          action: "save",
          recap_facts: [],
        },
        notes: "Nested run_context only",
      },
    ];

    const report = scoreActualResults({
      gold,
      actualRows,
      runId,
      revisions: {
        codeRevision: "git:abc123",
        pluginRevision: "hash:def456",
      },
    });

    expect(report.failed).toBe(2);
    expect(report.errorTypeCounts.routing).toBe(1);
    expect(report.errorTypeCounts.missing_context_propagation ?? 0).toBe(1);
    expect(report.failures[0]?.traceId).toBe("trace-nested-1");
  });

  it("scores pass/fail, error buckets, and regressions", () => {
    const runId = "2026-03-08T10:30:00.000Z";
    const previousRows: ActualResult[] = [
      {
        run_id: "2026-03-07T10:30:00.000Z",
        scenario_id: "recap-auth-resume",
        trace_id: "old-trace",
        bucket: "recap_hit_rate",
        skill_expected: "memory-recap",
        skill_actual: "memory-recap",
        actual: {
          action: "recap",
          recap_facts: ["current task", "next best action"],
        },
      },
    ];
    const actualRows: ActualResult[] = [
      {
        run_id: runId,
        scenario_id: "recap-auth-resume",
        trace_id: "trace-1",
        bucket: "recap_hit_rate",
        skill_expected: "memory-recap",
        skill_actual: "memory-intake",
        actual: {
          action: "save",
          recap_facts: [],
        },
        notes: "Routed to the wrong skill",
      },
      {
        run_id: runId,
        scenario_id: "evolution-safe-propose",
        trace_id: "trace-2",
        bucket: "false_apply_zero",
        skill_expected: "memory-evolution",
        skill_actual: "memory-evolution",
        actual: {
          action: "apply",
          evolution_mode: "apply",
        },
        notes: "Applied instead of proposing",
      },
    ];

    const report = scoreActualResults({
      gold,
      actualRows,
      previousRows,
      runId,
      revisions: {
        codeRevision: "git:abc123",
        pluginRevision: "hash:def456",
      },
    });

    expect(report.passed).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.errorTypeCounts.routing).toBe(1);
    expect(report.errorTypeCounts.guardrail).toBe(1);
    expect(report.regressions).toContain("recap-auth-resume");
    expect(report.failures[0]?.traceId).toBe("trace-1");
    expect(report.codeRevision).toBe("git:abc123");
  });
});
