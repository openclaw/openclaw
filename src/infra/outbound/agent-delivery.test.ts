import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+1999" })),
  resolveSessionDeliveryTarget: vi.fn(
    (params: {
      entry?: {
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
        lastChannel?: string;
        lastTo?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
      requestedChannel?: string;
      explicitTo?: string;
      explicitThreadId?: string | number;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    }) => {
      const sessionContext = params.entry?.deliveryContext ?? {
        channel: params.entry?.lastChannel,
        to: params.entry?.lastTo,
        accountId: params.entry?.lastAccountId,
        threadId: params.entry?.lastThreadId,
      };
      const lastChannel = params.turnSourceChannel ?? sessionContext.channel;
      const lastTo = params.turnSourceChannel ? params.turnSourceTo : sessionContext.to;
      const lastAccountId = params.turnSourceChannel
        ? params.turnSourceAccountId
        : sessionContext.accountId;
      const lastThreadId = params.turnSourceChannel
        ? params.turnSourceThreadId
        : sessionContext.threadId;
      const channel =
        params.requestedChannel === "last" || params.requestedChannel == null
          ? lastChannel
          : params.requestedChannel;
      const mode = params.explicitTo ? "explicit" : "implicit";
      const resolvedTo =
        params.explicitTo ?? (channel && channel === lastChannel ? lastTo : undefined);

      return {
        channel,
        to: resolvedTo,
        accountId: channel && channel === lastChannel ? lastAccountId : undefined,
        threadId:
          params.explicitThreadId ??
          (channel && channel === lastChannel ? lastThreadId : undefined),
        threadIdExplicit: params.explicitThreadId != null,
        mode,
        lastChannel,
        lastTo,
        lastAccountId,
        lastThreadId,
      };
    },
  ),
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  resolveSessionDeliveryTarget: mocks.resolveSessionDeliveryTarget,
}));

import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentDeliveryPlan, resolveAgentOutboundTarget } from "./agent-delivery.js";

beforeEach(() => {
  mocks.resolveOutboundTarget.mockClear();
  mocks.resolveSessionDeliveryTarget.mockClear();
});

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
});
