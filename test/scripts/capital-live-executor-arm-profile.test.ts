import { describe, expect, it } from "vitest";
import { buildCapitalLiveExecutorArmProfile } from "../../scripts/openclaw-capital-live-executor-arm-profile.mjs";

const profilePath = "D:/OpenClaw/.openclaw/trading/capital-live-executor-arm-profile.json";
const templatePath =
  "D:/OpenClaw/.openclaw/trading/templates/capital-live-executor-arm-profile.template.json";
const repoRoot = "D:\\OpenClaw";
const profileCheckCommand = `pnpm --dir ${repoRoot} capital:trade:live-executor-profile:check`;
const liveReadinessCheckCommand = `pnpm --dir ${repoRoot} capital:live-readiness:check`;

function baseProfile(overrides = {}) {
  return {
    schema: "openclaw.capital.live-executor-arm-profile.v1",
    executorId: "openclaw-managed-capital-live-executor",
    mode: "operator_managed_live_executor_arm_profile",
    armed: true,
    operatorSignature: "operator-confirmed-live-window",
    armedAt: "2026-05-26T12:00:00.000Z",
    expiresAt: "2026-05-26T12:10:00.000Z",
    maxTtlSeconds: 900,
    brokerWriteAuthorityTarget: "openclaw_managed_local_broker_executor",
    allowBrokerWriteWhenAllGatesPass: true,
    allowConversationAgentDirectWrite: false,
    killSwitch: true,
    canaryRequired: true,
    rollbackRequired: true,
    freshQuoteRequired: true,
    verifiedPositionRequired: true,
    adapterAckHashRequired: true,
    ...overrides,
  };
}

describe("capital live executor arm profile", () => {
  it("produces a staged re-arm candidate without arming the active profile", async () => {
    const report = await buildCapitalLiveExecutorArmProfile({
      repoRoot,
      now: new Date("2026-05-26T12:30:00.000Z"),
      profilePath,
      templatePath,
      profile: baseProfile(),
    });

    expect(report.status).toBe("expired");
    expect(report.allowBrokerWriteWhenAllGatesPass).toBe(false);
    expect(report.operatorReview).toMatchObject({
      status: "staged_rearm_candidate_ready_for_operator",
      activeProfileWriteSuppressed: true,
      conversationAgentsMayWriteActiveProfile: false,
      allowedWriter: "operator-managed-local-broker-executor-only",
      validationCommand: profileCheckCommand,
      postRearmValidationCommand: liveReadinessCheckCommand,
    });
    expect(report.operatorReview.handoffChecklist.map((item) => item.id)).toEqual([
      "review_staged_rearm_profile",
      "operator_managed_active_profile_rearm",
      "rerun_live_readiness",
    ]);
    expect(report.operatorReview.handoffChecklist).toContainEqual(
      expect.objectContaining({
        id: "operator_managed_active_profile_rearm",
        status: "pending_operator_managed_executor",
        validationCommand: profileCheckCommand,
      }),
    );
    expect(report.operatorReview.activeProfilePath).toContain(
      "capital-live-executor-arm-profile.json",
    );
    expect(report.operatorReview.stagedRearmProfilePath).not.toBe(
      report.operatorReview.activeProfilePath,
    );
    expect(report.operatorReview.rearmCandidate).toMatchObject({
      armed: false,
      allowBrokerWriteWhenAllGatesPass: false,
      allowConversationAgentDirectWrite: false,
      activeProfileWriteSuppressed: true,
      validationCommand: profileCheckCommand,
    });
    expect(report.safety).toMatchObject({
      generatedStagedRearmProfile: true,
      wroteActiveArmProfile: false,
      activeArmProfileWriteSuppressed: true,
      sentOrder: false,
      noLiveOrderSent: true,
    });
  });

  it("reports no re-arm required only while the active profile is valid", async () => {
    const report = await buildCapitalLiveExecutorArmProfile({
      repoRoot,
      now: new Date("2026-05-26T12:05:00.000Z"),
      profilePath,
      templatePath,
      profile: baseProfile(),
    });

    expect(report.status).toBe("armed");
    expect(report.allowBrokerWriteWhenAllGatesPass).toBe(true);
    expect(report.operatorReview.status).toBe("no_rearm_required");
    expect(report.operatorReview.validationCommand).toBe(profileCheckCommand);
    expect(report.operatorReview.postRearmValidationCommand).toBe(liveReadinessCheckCommand);
    expect(report.operatorReview.rearmCandidate.armed).toBe(false);
    expect(report.safety.wroteActiveArmProfile).toBe(false);
    expect(report.safety.sentOrder).toBe(false);
  });
});
