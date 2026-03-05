import { describe, it, expect } from "vitest";
import {
  runIdentityScopeMachine,
  type UnifiedMessage,
  type IntentContract,
  type SubjectCandidate,
} from "./stateMachine.js";

function makeMsg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    channel: "sms",
    channelIdentity: "+1 (305) 555-1212",
    messageText: "What is my balance?",
    timestampMs: 1_000_000,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<IntentContract> = {}): IntentContract {
  return {
    intentSlug: "what_is_my_current_balance",
    executionMode: "api-first",
    actionType: "read",
    authScope: ["ledger:read"],
    idResolution: "single_unit",
    isFinancial: true,
    ...overrides,
  };
}

function ownerCandidate(
  units: string[],
  overrides: Partial<SubjectCandidate> = {},
): SubjectCandidate {
  return {
    subjectId: "res_1",
    role: "owner",
    allowedPropertyIds: ["prop_1"],
    allowedUnitIds: units,
    identityConfidence: "high",
    lastVerifiedAtMs: undefined,
    ...overrides,
  };
}

function vendorCandidate(
  workOrderIds: string[],
  overrides: Partial<SubjectCandidate> = {},
): SubjectCandidate {
  return {
    subjectId: "vendor_1",
    role: "vendor",
    allowedPropertyIds: ["prop_1"],
    allowedUnitIds: ["u100"],
    allowedWorkOrderIds: workOrderIds,
    identityConfidence: "high",
    ...overrides,
  };
}

describe("Identity + Scope State Machine", () => {
  it("denies unknown identity when onboarding not allowed", async () => {
    const ctx = await runIdentityScopeMachine({
      msg: makeMsg(),
      intent: makeIntent(),
      requestId: "req1",
      identityLookup: async () => [],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.decision).toBe("deny");
    expect(ctx.denyReason).toBe("unknown_identity_on_channel");
  });

  it("requires step-up for unknown identity when onboarding allowed", async () => {
    const ctx = await runIdentityScopeMachine({
      msg: makeMsg(),
      intent: makeIntent(),
      requestId: "req2",
      identityLookup: async () => [],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: true,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.decision).toBe("stepup");
    expect(ctx.requiresOtp).toBe(true);
    expect(ctx.authLevel).toBe("stepup_required");
  });

  it("auto-selects scope when exactly one unit", async () => {
    const ctx = await runIdentityScopeMachine({
      msg: makeMsg(),
      intent: makeIntent({ isFinancial: false }),
      requestId: "req3",
      identityLookup: async () => [ownerCandidate(["402"])],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.activeUnitId).toBe("402");
    expect(ctx.decision).toBe("allow");
  });

  it("asks clarification when multiple units and cannot infer", async () => {
    const ctx = await runIdentityScopeMachine({
      msg: makeMsg({ messageText: "What is my balance?" }),
      intent: makeIntent(),
      requestId: "req4",
      identityLookup: async () => [ownerCandidate(["401", "402"])],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.decision).toBe("ask_clarification");
    expect(ctx.clarificationPrompt).toMatch(/Which unit/i);
  });

  it("infers unit safely from explicit text (Unit 402)", async () => {
    let stored: string | undefined;

    const ctx = await runIdentityScopeMachine({
      msg: makeMsg({ messageText: "Unit 402 - what is my balance?" }),
      intent: makeIntent(),
      requestId: "req5",
      identityLookup: async () => [ownerCandidate(["401", "402"])],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async (_key, unitId) => {
        stored = unitId;
      },
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.activeUnitId).toBe("402");
    expect(stored).toBe("402");
    expect(ctx.decision).toBe("stepup");
    expect(ctx.requiresOtp).toBe(true);
  });

  it("uses cached active unit for multi-unit owner", async () => {
    const ctx = await runIdentityScopeMachine({
      msg: makeMsg(),
      intent: makeIntent({ isFinancial: false }),
      requestId: "req6",
      identityLookup: async () => [ownerCandidate(["401", "402"])],
      sessionGetActiveUnit: async () => "401",
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.activeUnitId).toBe("401");
    expect(ctx.decision).toBe("allow");
  });

  it("denies when role lacks required scope", async () => {
    const renter: SubjectCandidate = {
      subjectId: "res_2",
      role: "renter",
      allowedPropertyIds: ["prop_1"],
      allowedUnitIds: ["402"],
      identityConfidence: "high",
    };

    const ctx = await runIdentityScopeMachine({
      msg: makeMsg(),
      intent: makeIntent({ authScope: ["ledger:read"], isFinancial: false }),
      requestId: "req7",
      identityLookup: async () => [renter],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.decision).toBe("deny");
    expect(ctx.denyReason).toBe("action_permission_denied");
  });

  it("allows vendor to update work order but not read ledger", async () => {
    const vendor = vendorCandidate(["wo_1"]);

    const workorderIntent = makeIntent({
      intentSlug: "update_work_order_status",
      authScope: ["workorder:write"],
      actionType: "write",
      isFinancial: false,
    });

    const ok = await runIdentityScopeMachine({
      msg: makeMsg({ messageText: "Update WO status" }),
      intent: workorderIntent,
      requestId: "req8",
      identityLookup: async () => [vendor],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ok.decision).toBe("allow");

    const ledgerIntent = makeIntent({
      intentSlug: "what_is_my_current_balance",
      authScope: ["ledger:read"],
      actionType: "read",
      isFinancial: true,
    });

    const denied = await runIdentityScopeMachine({
      msg: makeMsg({ messageText: "What is the balance?" }),
      intent: ledgerIntent,
      requestId: "req9",
      identityLookup: async () => [vendor],
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(denied.decision).toBe("deny");
    expect(denied.denyReason).toBe("action_permission_denied");
  });

  it("treats email alias identity as identity, but still scopes by units", async () => {
    const ctx = await runIdentityScopeMachine({
      msg: makeMsg({
        channel: "email",
        channelIdentity: "concierge@asktenant.ai",
        threadId: "thread_1",
        messageText: "Unit 402 - what is my balance?",
      }),
      intent: makeIntent(),
      requestId: "req10",
      identityLookup: async (identity) => {
        if (identity === "concierge@asktenant.ai") {
          return [ownerCandidate(["401", "402"])];
        }
        return [];
      },
      sessionGetActiveUnit: async () => undefined,
      sessionSetActiveUnit: async () => undefined,
      onboardingAllowed: false,
      otpRecencyMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: 2_000_000,
    });

    expect(ctx.channel).toBe("email");
    expect(ctx.activeUnitId).toBe("402");
    expect(ctx.decision).toBe("stepup");
  });
});
