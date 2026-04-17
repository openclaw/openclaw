import { describe, expect, it } from "vitest";
import { planDelivery } from "../../infra/outbound/surface-policy.js";

// Phase 4 REWORK (origin-respect): cron delivery routing.
//
// The prior model rerouted "internal ops" cron ids (main-auto-continue-*,
// acp-completion-*) into a configured `channels.operator` bucket. That was
// cross-contamination in the other direction. The current model is simpler:
// a cron job's delivery ALWAYS goes to the target its own `job.delivery`
// configures. Jobs without a `delivery` target are suppressed at the policy
// gate (`no_origin`). There is no operator-channel reroute anymore.
//
// These tests lock in the policy-gate behavior for cron-originated
// `messageClass: "progress"` sends so the `delivery-dispatch` layer can
// tag every cron delivery with that class without accidentally producing
// a reroute.

describe("Phase 4 cron origin-respect routing", () => {
  it("delivers cron progress sends at the job's configured target", () => {
    const decision = planDelivery({
      messageClass: "progress",
      surface: { channel: "discord", to: "channel:ops" },
    });
    expect(decision.outcome).toBe("deliver");
  });

  it("suppresses cron progress sends when the job has no delivery target", () => {
    const decision = planDelivery({
      messageClass: "progress",
      surface: { channel: "", to: "" },
    });
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "no_origin",
    });
  });

  it("honors notifyPolicy=silent for cron progress even with a valid target", () => {
    const decision = planDelivery({
      messageClass: "progress",
      surface: { channel: "discord", to: "channel:ops" },
      notifyPolicy: "silent",
    });
    expect(decision.outcome).toBe("suppress");
  });

  it("does not reroute notifyPolicy=operator_only; respects the origin surface", () => {
    // operator_only is a user hint that no longer translates into a bucket
    // reroute. With a valid origin, the send is delivered there.
    const decision = planDelivery({
      messageClass: "progress",
      surface: { channel: "discord", to: "channel:ops" },
      notifyPolicy: "operator_only",
    });
    expect(decision.outcome).toBe("deliver");
  });
});
