import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCapitalAdapterAckOperatorApplyVerifier } from "../../scripts/openclaw-capital-adapter-ack-operator-apply-verifier.mjs";

const repoRoot = "D:\\OpenClaw";
const sourcePath =
  "D:/OpenClaw/.openclaw/trading/staging/capital-external-broker-adapter-ack.staged-current.json";
const destinationPath = "D:/OpenClaw/.openclaw/trading/capital-external-broker-adapter-ack.json";
const rollbackVerifiedAt = "2026-05-26T08:29:20.000Z";
const sealedIntentSha256 = "REQ123";
const candidateText = `${JSON.stringify(
  {
    schema: "openclaw.capital.external-broker-adapter-ack.v1",
    owner: "operator",
    sealedIntentSha256,
    canary: { status: "pass", dryRun: true, sentOrder: false },
    rollback: { status: "pass", verifiedAt: rollbackVerifiedAt },
  },
  null,
  2,
)}\n`;
const activeText = `${JSON.stringify(
  {
    schema: "openclaw.capital.external-broker-adapter-ack.v1",
    owner: "operator",
    sealedIntentSha256: "OLD123",
    canary: { status: "pass", dryRun: true, sentOrder: false },
    rollback: { status: "pass", verifiedAt: rollbackVerifiedAt },
  },
  null,
  2,
)}\n`;

function sha256Text(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function packet() {
  return {
    schema: "openclaw.capital.external-broker-adapter-ack-refresh-packet.v1",
    status: "ready_for_operator_adapter_apply",
    owner: "operator-owned-broker-adapter-only",
    sourcePath,
    destinationPath,
    backupPath: "D:/OpenClaw/.openclaw/trading/staging/backup.json",
    sealedIntentSha256,
    activeSealedIntentSha256: "OLD123",
    candidateSealedIntentSha256: sealedIntentSha256,
    currentContentSha256: sha256Text(activeText),
    candidateContentSha256: sha256Text(candidateText),
    candidateRollbackVerifiedAt: rollbackVerifiedAt,
    safety: {
      sentOrder: false,
      brokerWriteAttempted: false,
      wroteActiveAdapterAck: false,
    },
  };
}

describe("capital adapter ack operator apply verifier", () => {
  it("marks the packet ready before operator-owned apply", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyVerifier({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      packet: await packet(),
      sourceText: candidateText,
      destinationText: activeText,
    });

    expect(report.status).toBe("ready_for_operator_apply");
    expect(report.blockers).toEqual([]);
    expect(report.applyVerdict).toMatchObject({
      activeState: "pre_apply_current_matches",
      operatorMayApply: true,
      operatorApplyVerified: false,
      sealedIntentSha256,
      sourceSealedIntentSha256: sealedIntentSha256,
      destinationSealedIntentSha256: "OLD123",
      candidateRollbackVerifiedAt: rollbackVerifiedAt,
    });
    expect(report.applyVerdict.validationCommands.applyVerifier).toBe(
      `pnpm --dir ${repoRoot} capital:trade:adapter-ack-apply-verifier:check`,
    );
    expect(report.safety).toMatchObject({
      wroteActiveAdapterAck: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
    });
  });

  it("verifies after operator-owned apply when active content equals candidate", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyVerifier({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      packet: await packet(),
      sourceText: candidateText,
      destinationText: candidateText,
    });

    expect(report.status).toBe("applied_verified");
    expect(report.applyVerdict).toMatchObject({
      activeState: "applied_candidate_matches",
      operatorMayApply: false,
      operatorApplyVerified: true,
      destinationSealedIntentSha256: sealedIntentSha256,
    });
    expect(report.safety.sentOrder).toBe(false);
  });

  it("blocks if active content drifted away from both current and candidate", async () => {
    const report = await buildCapitalAdapterAckOperatorApplyVerifier({
      repoRoot,
      generatedAt: "2026-05-26T09:00:00.000Z",
      packet: await packet(),
      sourceText: candidateText,
      destinationText: JSON.stringify({ sealedIntentSha256: "DRIFT" }),
    });

    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("destination:matches-known-packet-state");
  });
});
