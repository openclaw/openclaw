import { describe, expect, it, vi } from "vitest";
import { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";

function createNativeRuntimeStub() {
  return {
    availability: {
      isConfigured: vi.fn(),
      shouldHandle: vi.fn(),
    },
    presentation: {
      buildPendingPayload: vi.fn(),
      buildResolvedResult: vi.fn(),
      buildExpiredResult: vi.fn(),
    },
    transport: {
      prepareTarget: vi.fn(),
      deliverPending: vi.fn(),
    },
  };
}

describe("resolveChannelApprovalCapability", () => {
  it("falls back to legacy approval fields when approvalCapability is absent", () => {
    const authorizeActorAction = vi.fn();
    const getActionAvailabilityState = vi.fn();
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = createNativeRuntimeStub();
    const describeExecApprovalSetup = vi.fn();

    expect(
      resolveChannelApprovalCapability({
        auth: {
          authorizeActorAction,
          getActionAvailabilityState,
        },
        approvals: {
          describeExecApprovalSetup,
          delivery,
          nativeRuntime,
        },
      }),
    ).toEqual({
      authorizeActorAction,
      getActionAvailabilityState,
      describeExecApprovalSetup,
      delivery,
      nativeRuntime,
      render: undefined,
      native: undefined,
    });
  });

  it("merges partial approvalCapability fields with legacy approval wiring", () => {
    const capabilityAuth = vi.fn();
    const legacyAvailability = vi.fn();
    const legacyDelivery = { hasConfiguredDmRoute: vi.fn() };
    const capabilityNativeRuntime = createNativeRuntimeStub();

    expect(
      resolveChannelApprovalCapability({
        approvalCapability: {
          authorizeActorAction: capabilityAuth,
          nativeRuntime: capabilityNativeRuntime,
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
      nativeRuntime: capabilityNativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});

describe("resolveChannelApprovalAdapter", () => {
  it("preserves legacy delivery surfaces when approvalCapability only defines auth", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = createNativeRuntimeStub();
    const describeExecApprovalSetup = vi.fn();

    expect(
      resolveChannelApprovalAdapter({
        approvalCapability: {
          authorizeActorAction: vi.fn(),
        },
        approvals: {
          describeExecApprovalSetup,
          delivery,
          nativeRuntime,
        },
      }),
    ).toEqual({
      describeExecApprovalSetup,
      delivery,
      nativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});
