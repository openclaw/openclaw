import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../types.ts";
import {
  CONTROL_DIRECTOR_DIAGNOSTICS_EMPTY,
  countBlockedControlDirectorDiagnostics,
  latestControlDirectorDiagnosticsRows,
  summarizeControlDirectorDiagnostics,
} from "./control-director-diagnostics.ts";

function row(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: "agent:main:main",
    kind: "direct",
    updatedAt: 100,
    ...overrides,
  };
}

describe("control director diagnostics summary", () => {
  it("returns an explicit empty state when no diagnostics exist", () => {
    const summary = summarizeControlDirectorDiagnostics(row());

    expect(summary.status).toBe("No diagnostics");
    expect(summary.detail).toBe(CONTROL_DIRECTOR_DIAGNOSTICS_EMPTY);
    expect(summary.hasDiagnostics).toBe(false);
  });

  it("prioritizes unsupported truth claims as blocked", () => {
    const summary = summarizeControlDirectorDiagnostics(
      row({
        controlDirectorTruthAudit: [
          {
            ts: 10,
            status: "blocked",
            runId: "run-1",
            missing: ["github_run conclusion=success for current SHA"],
            payloadsChecked: 1,
            payloadsRewritten: 1,
            claims: [
              {
                claim: "remote proof passed",
                claimHash: "abc",
                claimType: "remote_proof",
                requiredEvidenceType: "github_run",
                matchStatus: "missing",
                missingCondition: "missing matching GitHub run success",
                rewriteAction: "blocked_unsupported_truth_claim",
              },
            ],
          },
        ],
      }),
    );

    expect(summary.status).toBe("Blocked unsupported claim");
    expect(summary.blocked).toBe(true);
    expect(summary.detail).toBe("missing matching GitHub run success");
    expect(summary.details).toContainEqual({ label: "Claim type", value: "remote_proof" });
    expect(summary.details).toContainEqual({ label: "Required evidence", value: "github_run" });
  });

  it("reports missing Judge approval instead of allowing complete-looking missions", () => {
    const summary = summarizeControlDirectorDiagnostics(
      row({
        controlDirectorMissionLedger: [
          {
            missionId: "mission-1",
            runId: "run-1",
            requestSummary: "finish feature",
            status: "complete",
            finalStatus: "complete",
            startedAt: 1,
            updatedAt: 2,
            continuationCount: 0,
            judgeCompletionGate: {
              status: "blocked",
              reason: "missing Judge APPROVE verdict",
              missing: ["judge approval"],
            },
          },
        ],
      }),
    );

    expect(summary.status).toBe("Judge approval missing");
    expect(summary.blocked).toBe(true);
    expect(summary.detail).toBe("missing Judge APPROVE verdict");
  });

  it("reports liveness fallback source and mission blocked details", () => {
    const summary = summarizeControlDirectorDiagnostics(
      row({
        controlDirectorLivenessAudit: [
          {
            ts: 3,
            runId: "run-2",
            action: "synthesized_blocked_no_visible_output",
            reason: "No user-visible payload was available for delivery.",
            source: "terminal_empty",
            classification: "empty",
            nextStatus: "blocked",
            continuationCount: 1,
            continuationQueued: false,
            payloadsChecked: 1,
            payloadsSynthesized: 1,
          },
        ],
        controlDirectorMissionLedger: [
          {
            missionId: "mission-2",
            runId: "run-2",
            requestSummary: "debug issue",
            status: "blocked",
            startedAt: 1,
            updatedAt: 3,
            continuationCount: 1,
            finalStatus: "blocked",
            nextBuildGap: "collect visible final response",
            completionGrade: 7,
            criticality: 10,
          },
        ],
      }),
    );

    expect(summary.status).toBe("Liveness fallback");
    expect(summary.details).toContainEqual({ label: "Liveness source", value: "terminal_empty" });
    expect(summary.details).toContainEqual({ label: "Completion Grade", value: "7/10" });
    expect(summary.details).toContainEqual({ label: "Criticality", value: "10/10" });
  });

  it("counts blocked diagnostics and sorts recent diagnostic rows", () => {
    const blocked = row({
      key: "agent:main:blocked",
      updatedAt: 10,
      controlDirectorTruthAudit: [
        {
          ts: 1,
          status: "blocked",
          missing: ["command exit 0"],
          payloadsChecked: 1,
          payloadsRewritten: 1,
          claims: [
            {
              claim: "tests passed",
              claimHash: "hash",
              claimType: "verification",
              requiredEvidenceType: "command",
              matchStatus: "missing",
            },
          ],
        },
      ],
    });
    const ok = row({
      key: "agent:main:ok",
      updatedAt: 30,
      controlDirectorTruthAudit: [
        {
          ts: 2,
          status: "passed",
          missing: [],
          payloadsChecked: 1,
          payloadsRewritten: 0,
          claims: [],
        },
      ],
    });

    expect(countBlockedControlDirectorDiagnostics([blocked, ok])).toBe(1);
    expect(latestControlDirectorDiagnosticsRows([blocked, ok]).map((item) => item.key)).toEqual([
      "agent:main:ok",
      "agent:main:blocked",
    ]);
  });
});
