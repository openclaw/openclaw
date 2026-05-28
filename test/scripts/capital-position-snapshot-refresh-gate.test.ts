import { describe, expect, it } from "vitest";
import { buildCapitalPositionSnapshotRefreshGate } from "../../scripts/openclaw-capital-position-snapshot-refresh-gate.mjs";

const repoRoot = "D:\\OpenClaw";

function directStatus(overrides = {}) {
  return {
    summary: {
      safety: {
        noLiveOrderSent: true,
        sentOrder: false,
      },
      position: {
        status: "verified",
        usable: true,
        path: "D:/OpenClaw/config/capital-verified-position-snapshot.json",
        verifiedAt: "2026-05-26T07:10:57.3351330+08:00",
        verifiedBy: "operator-confirmed-via-codex",
        verifiedAgeSeconds: 55410,
        maxFreshSeconds: 43200,
        freshnessStatus: "stale",
        hasOpenPosition: true,
        netContracts: -2,
        decisionStatus: "verified_open_position_manual_exit_review",
        handoff: {
          status: "stale_operator_refresh_required",
          activeSnapshotPath: "D:/OpenClaw/config/capital-verified-position-snapshot.json",
          templatePath:
            "D:/OpenClaw/.openclaw/trading/templates/capital-verified-position-snapshot.template.json",
          stagedRefreshPath:
            "D:/OpenClaw/.openclaw/trading/staging/capital-verified-position-snapshot.staged-refresh.json",
          activeSnapshotWriteSuppressed: true,
          conversationAgentsMayWriteActiveSnapshot: false,
          allowedWriter: "operator-owned-position-query-only",
          validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:direct:status:check",
          handoffChecklist: [
            {
              order: 1,
              id: "review_current_broker_position",
              status: "pending_operator_review",
              validationCommand: "pnpm --dir D:\\OpenClaw capital:trade:direct:status:check",
            },
          ],
        },
        ...overrides,
      },
    },
    paths: {
      reportPath:
        "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-direct-operation-status-latest.json",
    },
  };
}

describe("capital position snapshot refresh gate", () => {
  it("blocks stale verified snapshots and creates operator refresh candidate", async () => {
    const report = await buildCapitalPositionSnapshotRefreshGate({
      repoRoot,
      generatedAt: "2026-05-26T14:00:00.000Z",
      directStatus: directStatus(),
    });

    expect(report.status).toBe("stale_refresh_required");
    expect(report.operatorRefresh.operatorMayRefresh).toBe(true);
    expect(report.blockers).toContain("snapshot:fresh-within-max-age");
    expect(report.stagedRefreshCandidate).toMatchObject({
      verified: false,
      activeSnapshotWriteSuppressed: true,
      allowedWriter: "operator-owned-position-query-only",
    });
    expect(report.stagedRefreshCandidate.positions).toEqual([
      { symbol: "CN0000", side: "short", qty: 2 },
    ]);
    expect(report.safety.noLiveOrderSent).toBe(true);
  });

  it("passes fresh snapshots without allowing refresh", async () => {
    const report = await buildCapitalPositionSnapshotRefreshGate({
      repoRoot,
      generatedAt: "2026-05-26T14:00:00.000Z",
      directStatus: directStatus({
        verifiedAgeSeconds: 120,
        freshnessStatus: "fresh",
        handoff: {
          ...directStatus().summary.position.handoff,
          status: "fresh",
        },
      }),
    });

    expect(report.status).toBe("fresh_verified");
    expect(report.blockers).toEqual([]);
    expect(report.operatorRefresh.operatorMayRefresh).toBe(false);
  });

  it("blocks invalid snapshots without granting refresh when write suppression is absent", async () => {
    const report = await buildCapitalPositionSnapshotRefreshGate({
      repoRoot,
      generatedAt: "2026-05-26T14:00:00.000Z",
      directStatus: directStatus({
        status: "missing",
        usable: false,
        freshnessStatus: "",
        handoff: {
          ...directStatus().summary.position.handoff,
          activeSnapshotWriteSuppressed: false,
        },
      }),
    });

    expect(report.status).toBe("missing_or_invalid_refresh_required");
    expect(report.operatorRefresh.operatorMayRefresh).toBe(false);
    expect(report.blockers).toContain("snapshot:usable-verified");
    expect(report.blockers).toContain("handoff:active-write-suppressed");
  });
});
