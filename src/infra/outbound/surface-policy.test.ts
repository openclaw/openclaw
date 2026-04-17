import { describe, expect, it } from "vitest";
import { planDelivery, type DeliveryDecisionInput } from "./surface-policy.js";

const baseSurface = { channel: "discord", to: "channel:123" };

function makeInput(overrides: Partial<DeliveryDecisionInput>): DeliveryDecisionInput {
  return {
    messageClass: "final_reply",
    surface: baseSurface,
    ...overrides,
  };
}

describe("planDelivery", () => {
  it("ALWAYS delivers blocked messages (Blocked-Child Protocol invariant)", () => {
    // Even with silent policy and no valid surface: blocked MUST pass through.
    const decision = planDelivery(
      makeInput({
        messageClass: "blocked",
        notifyPolicy: "silent",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("delivers blocked even when origin is missing", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "blocked",
        surface: { channel: "", to: "" },
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

  it("delivers boot class at its origin surface", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "boot",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("suppresses boot class when no origin surface is available", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "boot",
        surface: { channel: "", to: "" },
      }),
    );
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "no_origin",
    });
  });

  it("delivers resume class at its origin surface", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "resume",
      }),
    );
    expect(decision.outcome).toBe("deliver");
  });

  it("suppresses resume class when origin is missing", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "resume",
        surface: { channel: "", to: "" },
      }),
    );
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "no_origin",
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

  it("delivers progress/completion at their origin surface when notifyPolicy is operator_only", () => {
    // operator_only no longer reroutes — with a valid origin, it passes through.
    for (const messageClass of ["progress", "completion", "final_reply"] as const) {
      const decision = planDelivery(
        makeInput({
          messageClass,
          notifyPolicy: "operator_only",
        }),
      );
      expect(decision.outcome).toBe("deliver");
    }
  });

  it("suppresses progress when there is no valid origin surface", () => {
    const decision = planDelivery(
      makeInput({
        messageClass: "progress",
        surface: { channel: "", to: "" },
      }),
    );
    expect(decision).toMatchObject({
      outcome: "suppress",
      reason: "no_origin",
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
