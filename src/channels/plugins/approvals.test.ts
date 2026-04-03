import { describe, expect, it, vi } from "vitest";
import { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";

describe("resolveChannelApprovalCapability", () => {
  it("falls back to legacy approval fields when approvalCapability is absent", () => {
    const authorizeActorAction = vi.fn();
    const getActionAvailabilityState = vi.fn();
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalCapability({
        auth: {
          authorizeActorAction,
          getActionAvailabilityState,
        },
        approvals: {
          delivery,
        },
      }),
    ).toEqual({
      authorizeActorAction,
      getActionAvailabilityState,
      delivery,
      render: undefined,
      native: undefined,
    });
  });

  it("merges partial approvalCapability fields with legacy approval wiring", () => {
    const capabilityAuth = vi.fn();
    const legacyAvailability = vi.fn();
    const legacyDelivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalCapability({
        approvalCapability: {
          authorizeActorAction: capabilityAuth,
        },
        auth: {
          getActionAvailabilityState: legacyAvailability,
        },
        approvals: {
          delivery: legacyDelivery,
        },
      }),
    ).toEqual({
      authorizeActorAction: capabilityAuth,
      getActionAvailabilityState: legacyAvailability,
      delivery: legacyDelivery,
      render: undefined,
      native: undefined,
    });
  });
});

describe("resolveChannelApprovalAdapter", () => {
  it("preserves legacy delivery surfaces when approvalCapability only defines auth", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalAdapter({
        approvalCapability: {
          authorizeActorAction: vi.fn(),
        },
        approvals: {
          delivery,
        },
      }),
    ).toEqual({
      delivery,
      render: undefined,
      native: undefined,
    });
  });
});
