import { describe, expect, it } from "vitest";
import { buildCapitalAdapterAckRefreshPacket } from "../../scripts/openclaw-capital-adapter-ack-refresh-packet.mjs";

const repoRoot = "D:\\OpenClaw";
const sourcePath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json";
const destinationPath = "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json";
const rollbackVerifiedAt = "2026-05-26T08:29:20.000Z";
const sealedIntentSha256 = "REQ123";

const handoff = {
  status: "ready_for_operator_handoff",
  sealedIntentSha256,
  operatorHandoff: {
    sourcePath,
    destinationPath,
    candidateRollbackVerifiedAt: rollbackVerifiedAt,
  },
  safety: {
    noLiveOrderSent: true,
  },
  paths: {
    reportPath:
      "D:/OpenClaw/reports/hermes-agent/state/openclaw-capital-adapter-ack-hash-handoff-verifier-latest.json",
    sourcePath,
    destinationPath,
  },
};

describe("capital adapter ack refresh packet", () => {
  it("builds a report-only atomic apply packet for the operator adapter", async () => {
    const report = await buildCapitalAdapterAckRefreshPacket({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      handoff,
      sourceText: JSON.stringify(
        {
          schema: "openclaw.capital.external-broker-adapter-ack.v1",
          owner: "operator",
          sealedIntentSha256,
          canary: { status: "pass", dryRun: true, sentOrder: false },
          rollback: { status: "pass", verifiedAt: rollbackVerifiedAt },
        },
        null,
        2,
      ),
      destinationText: JSON.stringify(
        {
          schema: "openclaw.capital.external-broker-adapter-ack.v1",
          owner: "operator",
          sealedIntentSha256: "OLD123",
          canary: { status: "pass", dryRun: true, sentOrder: false },
          rollback: { status: "pass", verifiedAt: rollbackVerifiedAt },
        },
        null,
        2,
      ),
    });

    expect(report.status).toBe("ready_for_operator_adapter_apply");
    expect(report.blockers).toEqual([]);
    expect(report.refreshPacket).toMatchObject({
      owner: "operator-owned-broker-adapter-only",
      sourcePath,
      destinationPath,
      sealedIntentSha256,
      activeSealedIntentSha256: "OLD123",
      candidateSealedIntentSha256: sealedIntentSha256,
      candidateRollbackVerifiedAt: rollbackVerifiedAt,
    });
    expect(report.refreshPacket.currentContentSha256).not.toBe(
      report.refreshPacket.candidateContentSha256,
    );
    expect(report.refreshPacket.atomicApplyPlan).toContain(
      "write_candidate_to_destination_path_using_atomic_replace",
    );
    expect(report.refreshPacket.validationCommands.adapterAck).toBe(
      `pnpm --dir ${repoRoot} capital:trade:adapter-ack:check`,
    );
    expect(report.safety).toMatchObject({
      generatedPacketOnly: true,
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    });
    expect(report.machineLine).toContain("noOrderWrite=true");
  });

  it("blocks when the active ack already matches the sealed intent", async () => {
    const report = await buildCapitalAdapterAckRefreshPacket({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      handoff,
      sourceText: JSON.stringify({
        sealedIntentSha256,
        rollback: { verifiedAt: rollbackVerifiedAt },
      }),
      destinationText: JSON.stringify({
        sealedIntentSha256,
        rollback: { verifiedAt: rollbackVerifiedAt },
      }),
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("hash:active-still-mismatched");
    expect(report.safety.sentOrder).toBe(false);
  });
});
