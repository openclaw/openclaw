import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+1999" })),
}));

vi.mock("./targets.js", async () => {
  const actual = await vi.importActual<typeof import("./targets.js")>("./targets.js");
  return {
    ...actual,
    resolveOutboundTarget: mocks.resolveOutboundTarget,
  };
});

import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentDeliveryPlan, resolveAgentOutboundTarget } from "./agent-delivery.js";
import { HEARTBEAT_SENDER_PLACEHOLDER } from "./targets.js";

describe("agent delivery helpers", () => {
  it("builds a delivery plan from session delivery context", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s1",
        updatedAt: 1,
        deliveryContext: { channel: "whatsapp", to: "+1555", accountId: "work" },
      },
      requestedChannel: "last",
      explicitTo: undefined,
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("whatsapp");
    expect(plan.resolvedTo).toBe("+1555");
    expect(plan.resolvedAccountId).toBe("work");
    expect(plan.deliveryTargetMode).toBe("implicit");
  });

  it("resolves fallback targets when no explicit destination is provided", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s2",
        updatedAt: 2,
        deliveryContext: { channel: "whatsapp" },
      },
      requestedChannel: "last",
      explicitTo: undefined,
      accountId: undefined,
      wantsDelivery: true,
    });

    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "implicit",
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledTimes(1);
    expect(resolved.resolvedTarget?.ok).toBe(true);
    expect(resolved.resolvedTo).toBe("+1999");
  });

  it("does not inject a default deliverable channel when session has none", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: undefined,
      requestedChannel: "last",
      explicitTo: undefined,
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("webchat");
    expect(plan.deliveryTargetMode).toBeUndefined();
  });

  it("skips outbound target resolution when explicit target validation is disabled", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s3",
        updatedAt: 3,
        deliveryContext: { channel: "whatsapp", to: "+1555" },
      },
      requestedChannel: "last",
      explicitTo: "+1555",
      accountId: undefined,
      wantsDelivery: true,
    });

    mocks.resolveOutboundTarget.mockClear();
    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTo).toBe("+1555");
  });

  it("prefers turn-source delivery context over session last route", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s4",
        updatedAt: 4,
        deliveryContext: { channel: "slack", to: "U_WRONG", accountId: "wrong" },
      },
      requestedChannel: "last",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+17775550123",
      turnSourceAccountId: "work",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("whatsapp");
    expect(plan.resolvedTo).toBe("+17775550123");
    expect(plan.resolvedAccountId).toBe("work");
  });

  it("does not reuse mutable session to when only turnSourceChannel is provided", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s5",
        updatedAt: 5,
        deliveryContext: { channel: "slack", to: "U_WRONG" },
      },
      requestedChannel: "last",
      turnSourceChannel: "whatsapp",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("whatsapp");
    expect(plan.resolvedTo).toBeUndefined();
  });

  it("does not use 'heartbeat' placeholder as delivery target", () => {
    // This tests the fix for #35300 and #39756:
    // When lastTo is set to "heartbeat" (a placeholder), it should not be
    // used as the delivery target, preventing cross-channel delivery bugs.
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s4",
        updatedAt: 4,
        deliveryContext: { channel: "feishu", to: HEARTBEAT_SENDER_PLACEHOLDER },
      },
      requestedChannel: "last",
      explicitTo: undefined,
      accountId: undefined,
      wantsDelivery: true,
    });

    // When lastTo is "heartbeat", resolvedTo should be undefined
    // (the key fix - we don't use "heartbeat" as delivery target)
    expect(plan.resolvedTo).toBeUndefined();
  });
});
