import { describe, expect, it } from "vitest";
import {
  planDelivery,
  type DeliveryDecisionInput,
  type ResolvedSurfaceTarget,
} from "./surface-policy.js";

const baseSurface = { channel: "discord", to: "channel:123" };
const operatorChannel: ResolvedSurfaceTarget = {
  channel: "discord",
  to: "operator-ch",
};

function makeInput(overrides: Partial<DeliveryDecisionInput>): DeliveryDecisionInput {
  return {
    messageClass: "final_reply",
    surface: baseSurface,
    ...overrides,
  };
}

describe("planDelivery", () => {
  it("ALWAYS delivers blocked messages (Blocked-Child Protocol invariant)", () => {
    // Even with silent policy, no operator channel, and a user surface: blocked MUST pass through.
    const decision = planDelivery(
      makeInput({
        messageClass: "blocked",
        notifyPolicy: "silent",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("delivers blocked even with operator_only policy", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "blocked",
        notifyPolicy: "operator_only",
        operatorChannel,
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("suppresses internal_narration on user surfaces", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "internal_narration",
      }),
    );
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "class_suppressed_for_surface",
    });
  });

  it("reroutes boot class to operator channel when available", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "boot",
        operatorChannel,
      }),
    );
    expect(decision).toMatchObject({
      outcome: "reroute",
      reason: "boot_to_operator_channel",
      target: operatorChannel,
    });
  });

  it("suppresses boot class when no operator channel is available", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "boot",
      }),
    );
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "operator_only_no_channel",
    });
  });

  it("reroutes resume class like boot", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "resume",
        operatorChannel,
      }),
    );
    expect(decision).toMatchObject({
      outcome: "reroute",
      reason: "boot_to_operator_channel",
    });
  });

  it("suppresses progress/completion when notifyPolicy is silent", () => {
    for (const messageClass of ["progress", "completion", "final_reply"] as const) {
      const decision = planDelivery(
        makeInput({
          messageClass,
          notifyPolicy: "silent",
        }),
      );
      expect(decision).toMatchObject({
        outcome: "suppress",
        reason: "class_suppressed_for_surface",
      });
    }
  });

  it("reroutes progress/completion to operator channel when notifyPolicy is operator_only", () => {
    for (const messageClass of ["progress", "completion", "final_reply"] as const) {
      const decision = planDelivery(
        makeInput({
          messageClass,
          notifyPolicy: "operator_only",
          operatorChannel,
        }),
      );
      expect(decision).toMatchObject({
        outcome: "reroute",
        reason: "cron_to_operator_channel",
        target: operatorChannel,
      });
    }
  });

  it("suppresses when operator_only policy has no operator channel", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "progress",
        notifyPolicy: "operator_only",
      }),
    );
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "operator_only_no_channel",
    });
  });

  it("delivers final_reply on a user surface by default", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "final_reply",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("delivers progress on a user surface with default notify policy", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "progress",
        notifyPolicy: "state_changes",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("delivers completion on a user surface with done_only policy", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "completion",
        notifyPolicy: "done_only",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });
});
